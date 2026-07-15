[CmdletBinding()]
param(
  [switch]$SelfTest,
  [switch]$LayoutTest
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script:RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$script:CatalogPath = Join-Path $script:RepoRoot "content\catalog.json"
$script:DeliveryPath = Join-Path $script:RepoRoot "content\delivery.private.json"
$script:Utf8NoBom = New-Object Text.UTF8Encoding($false)
$script:Catalog = $null
$script:CatalogFingerprint = ""
$script:Delivery = $null
$script:DeliveryFingerprint = ""
$script:EditingCourseId = ""
$script:SyncRunning = $false
$script:SyncProcess = $null
$script:SyncStdoutTask = $null
$script:SyncStderrTask = $null
$script:AutoSyncRequested = $false

function Get-CatalogSnapshot {
  param([string]$Path = $script:CatalogPath)

  if (-not [IO.File]::Exists($Path)) { throw "Không tìm thấy catalog: $Path" }
  $bytes = [IO.File]::ReadAllBytes($Path)
  $text = [Text.Encoding]::UTF8.GetString($bytes).TrimStart([char]0xFEFF)
  try { $catalog = $text | ConvertFrom-Json } catch { throw "catalog.json không phải JSON hợp lệ: $($_.Exception.Message)" }
  if ($null -eq $catalog -or $null -eq $catalog.PSObject.Properties["courses"]) {
    throw "catalog.json thiếu mảng courses."
  }

  $sha = [Security.Cryptography.SHA256]::Create()
  try { $hash = [Convert]::ToBase64String($sha.ComputeHash($bytes)) } finally { $sha.Dispose() }
  $file = Get-Item -LiteralPath $Path
  [pscustomobject]@{
    Catalog = $catalog
    Fingerprint = "$($file.LastWriteTimeUtc.Ticks):$($bytes.Length):$hash"
  }
}

function Get-DeliverySnapshot {
  param([string]$Path = $script:DeliveryPath)

  if (-not [IO.File]::Exists($Path)) {
    return [pscustomobject]@{
      Delivery = [pscustomobject][ordered]@{ driveFolders = [pscustomobject][ordered]@{} }
      Fingerprint = "missing"
    }
  }
  $bytes = [IO.File]::ReadAllBytes($Path)
  $text = [Text.Encoding]::UTF8.GetString($bytes).TrimStart([char]0xFEFF)
  try { $delivery = $text | ConvertFrom-Json } catch { throw "delivery.private.json không phải JSON hợp lệ: $($_.Exception.Message)" }
  if ($null -eq $delivery -or $null -eq $delivery.PSObject.Properties["driveFolders"] -or $null -eq $delivery.driveFolders) {
    throw "delivery.private.json thiếu object driveFolders."
  }
  foreach ($property in @($delivery.driveFolders.PSObject.Properties)) {
    if ($property.Name -cnotmatch "^[a-z0-9][a-z0-9_-]{0,79}$" -or -not (Resolve-DriveFolderId ([string]$property.Value))) {
      throw "delivery.private.json có course ID hoặc folder ID không hợp lệ: $($property.Name)"
    }
  }
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $hash = [Convert]::ToBase64String($sha.ComputeHash($bytes)) } finally { $sha.Dispose() }
  $file = Get-Item -LiteralPath $Path
  [pscustomobject]@{
    Delivery = $delivery
    Fingerprint = "$($file.LastWriteTimeUtc.Ticks):$($bytes.Length):$hash"
  }
}

function Save-CatalogAtomically {
  param(
    [Parameter(Mandatory = $true)]$Catalog,
    [string]$Path = $script:CatalogPath
  )

  $directory = [IO.Path]::GetDirectoryName($Path)
  $temporary = Join-Path $directory (".{0}.{1}.tmp" -f [IO.Path]::GetFileName($Path), [Guid]::NewGuid().ToString("N"))
  $backup = "$Path.manager-backup"
  $json = ($Catalog | ConvertTo-Json -Depth 100) + [Environment]::NewLine
  $bytes = $script:Utf8NoBom.GetBytes($json)

  try {
    $stream = New-Object IO.FileStream($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough)
    try {
      $stream.Write($bytes, 0, $bytes.Length)
      $stream.Flush($true)
    } finally {
      $stream.Dispose()
    }
    if ([IO.File]::Exists($Path)) {
      [IO.File]::Replace($temporary, $Path, $backup, $true)
    } else {
      [IO.File]::Move($temporary, $Path)
    }
  } finally {
    if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
  }
}

function ConvertTo-SlugBase {
  param([string]$Value)

  $value = $Value.Trim().Replace("Đ", "D").Replace("đ", "d").Normalize([Text.NormalizationForm]::FormD)
  $clean = New-Object Text.StringBuilder
  foreach ($character in $value.ToCharArray()) {
    if ([Globalization.CharUnicodeInfo]::GetUnicodeCategory($character) -ne [Globalization.UnicodeCategory]::NonSpacingMark) {
      [void]$clean.Append($character)
    }
  }
  $slug = [regex]::Replace($clean.ToString().Normalize([Text.NormalizationForm]::FormC).ToLowerInvariant(), "[^a-z0-9]+", "-").Trim("-")
  if (-not $slug) { $slug = "khoa-hoc" }
  if ($slug.Length -gt 64) { $slug = $slug.Substring(0, 64).TrimEnd("-") }
  $slug
}

function New-UniqueCourseId {
  param([string]$Title, [object[]]$Courses)

  $base = ConvertTo-SlugBase $Title
  $used = @($Courses | ForEach-Object { [string]$_.id })
  $candidate = $base
  $number = 2
  while ($used -contains $candidate) {
    $suffix = "-$number"
    $prefixLength = [Math]::Min($base.Length, 79 - $suffix.Length)
    $candidate = $base.Substring(0, $prefixLength).TrimEnd("-") + $suffix
    $number++
  }
  $candidate
}

function Test-HttpsUrl {
  param([string]$Value, [int]$MaxLength = 2000)

  if (-not $Value) { return $true }
  $uri = $null
  [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$uri) -and
    $uri.Scheme -ceq "https" -and
    -not [string]::IsNullOrWhiteSpace($uri.Host) -and
    -not $uri.UserInfo -and
    $uri.AbsoluteUri.Length -le $MaxLength
}

function Normalize-GoogleAccessEmail {
  param([string]$Value)

  $email = ([string]$Value).Trim().ToLowerInvariant()
  if (-not $email -or $email.Length -gt 254 -or $email -match '[\s"\\\p{Cc}]') { return "" }
  $parts = @($email -split "@", 2)
  if ($parts.Count -ne 2) { return "" }
  $local = $parts[0]
  $domain = $parts[1]
  if ($local.StartsWith(".") -or $local.EndsWith(".") -or $local.Contains("..") -or $local.Contains("+")) { return "" }
  $atomPattern = '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]{1,64}$'
  $domainPattern = '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$'
  if ($local -cnotmatch $atomPattern -or $domain -cnotmatch $domainPattern) { return "" }
  $email
}

function Resolve-DriveFolderId {
  param([string]$Value)

  $value = $Value.Trim()
  if (-not $value) { return "" }
  if ($value -cmatch "^[A-Za-z0-9_-]{10,200}$") { return $value }

  $uri = $null
  if (-not [Uri]::TryCreate($value, [UriKind]::Absolute, [ref]$uri) -or
      $uri.Scheme -cne "https" -or
      $uri.Host -ine "drive.google.com" -or
      $uri.UserInfo) {
    return ""
  }

  $path = [Uri]::UnescapeDataString($uri.AbsolutePath).TrimEnd("/")
  if ($path -match "^/drive(?:/u/\d+)?/folders/([A-Za-z0-9_-]{10,200})$") { return $matches[1] }
  ""
}

function Get-CourseDeliveryMode {
  param($Course)

  $mode = [string]$Course.deliveryMode
  if (@("DRIVE", "STREAM", "NON-STREAM") -contains $mode) { return $mode }
  if (-not $mode -and $Course.streamAvailable -eq $true) { return "STREAM" }
  "NON-STREAM"
}

function Get-PrivateDriveFolder {
  param([string]$CourseId, $Delivery = $script:Delivery)

  if ($null -eq $Delivery -or $null -eq $Delivery.driveFolders) { return "" }
  $property = $Delivery.driveFolders.PSObject.Properties[$CourseId]
  if ($null -eq $property) { return "" }
  [string]$property.Value
}

function Set-PrivateDriveFolder {
  param($Delivery, [string]$CourseId, [string]$FolderId)

  if ($null -eq $Delivery.PSObject.Properties["driveFolders"] -or $null -eq $Delivery.driveFolders) {
    Set-CourseProperty $Delivery "driveFolders" ([pscustomobject][ordered]@{})
  }
  $property = $Delivery.driveFolders.PSObject.Properties[$CourseId]
  if ($FolderId) {
    if ($null -eq $property) {
      $Delivery.driveFolders | Add-Member -MemberType NoteProperty -Name $CourseId -Value $FolderId
    } else {
      $property.Value = $FolderId
    }
  } elseif ($null -ne $property) {
    $Delivery.driveFolders.PSObject.Properties.Remove($CourseId)
  }
}

function Remove-CourseData {
  param($Catalog, $Delivery, [string]$CourseId)

  if ($CourseId -cnotmatch "^[a-z0-9][a-z0-9_-]{0,79}$") {
    throw "Mã khóa học cần xóa không hợp lệ."
  }
  $courses = @($Catalog.courses)
  $matches = @($courses | Where-Object { [string]$_.id -ceq $CourseId })
  if ($matches.Count -eq 0) { throw "Không còn tìm thấy khóa học mã $CourseId." }
  if ($matches.Count -ne 1) { throw "Catalog có nhiều khóa trùng mã $CourseId; chưa xóa nội dung nào." }
  $course = $matches[0]

  $Catalog.courses = @($courses | Where-Object { [string]$_.id -cne $CourseId })
  Set-PrivateDriveFolder $Delivery $CourseId ""
  $course
}

function Get-CourseValidationError {
  param(
    [string]$Title,
    [string]$Description,
    [decimal]$Price,
    [string]$PlanTier,
    [bool]$RightsVerified,
    [bool]$Published,
    [bool]$SaleEnabled,
    [string]$DeliveryMode,
    [bool]$HasPublishedLesson,
    [string]$DriveFolderValue,
    [string]$ImageUrl,
    [string]$PreviewUrl
  )

  if ([string]::IsNullOrWhiteSpace($Title)) { return "Hãy nhập tên khóa học." }
  if ($Title.Length -gt 100) { return "Tên khóa học tối đa 100 ký tự." }
  if ([regex]::IsMatch($Title, "[\p{Cc}\u202A-\u202E\u2066-\u2069]")) { return "Tên khóa học không được chứa ký tự điều khiển hoặc đổi hướng chữ." }
  if ($Description.Length -gt 4000) { return "Mô tả tối đa 4.000 ký tự." }
  if ([regex]::IsMatch($Description, "[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\u202A-\u202E\u2066-\u2069]")) { return "Mô tả chứa ký tự điều khiển hoặc đổi hướng chữ không hợp lệ." }
  if ($Price -lt 0 -or $Price -ne [decimal]::Truncate($Price)) { return "Giá phải là số nguyên không âm." }
  if (@("basic", "full") -notcontains $PlanTier) { return "Gói phải là basic hoặc full." }
  if (@("NON-STREAM", "DRIVE", "STREAM") -notcontains $DeliveryMode) { return "Hình thức giao nội dung không hợp lệ." }
  if ($Published -and -not $RightsVerified) { return "Muốn công khai trên web, bạn phải xác nhận quyền phân phối khóa học." }
  if ($SaleEnabled -and -not $Published) { return "Muốn mở thanh toán, khóa học phải được công khai trên web." }
  if ($SaleEnabled -and -not $RightsVerified) { return "Muốn mở thanh toán, bạn phải xác nhận quyền phân phối khóa học." }
  if ($SaleEnabled -and $Price -le 0) { return "Muốn mở thanh toán, giá khóa học phải lớn hơn 0." }
  if ($SaleEnabled -and $DeliveryMode -eq "NON-STREAM") { return "Khóa NON-STREAM chưa có cách giao nội dung nên không thể mở thanh toán." }
  if ($SaleEnabled -and $DeliveryMode -eq "STREAM" -and -not $HasPublishedLesson) { return "Muốn mở thanh toán STREAM, khóa học phải có ít nhất một bài HLS đã published." }
  if ($DeliveryMode -eq "DRIVE" -and -not (Resolve-DriveFolderId $DriveFolderValue)) { return "Khóa DRIVE cần folder ID hoặc URL thư mục drive.google.com hợp lệ." }
  if ($ImageUrl.Length -gt 2000 -or -not (Test-HttpsUrl $ImageUrl 2000)) { return "URL ảnh bìa phải là liên kết HTTPS hợp lệ (tối đa 2.000 ký tự)." }
  if ($PreviewUrl.Length -gt 512 -or -not (Test-HttpsUrl $PreviewUrl 512)) { return "Link preview phải là liên kết HTTPS hợp lệ (tối đa 512 ký tự)." }
  $null
}

function Set-CourseProperty {
  param($Course, [string]$Name, $Value)

  if ($null -eq $Course.PSObject.Properties[$Name]) {
    $Course | Add-Member -MemberType NoteProperty -Name $Name -Value $Value
  } else {
    $Course.$Name = $Value
  }
}

function Invoke-SelfTest {
  if ((ConvertTo-SlugBase "Khóa học Đồ họa 3D!") -ne "khoa-hoc-do-hoa-3d") { throw "Slug Unicode thất bại" }
  $ids = @([pscustomobject]@{ id = "khoa-hoc" })
  if ((New-UniqueCourseId "Khóa học" $ids) -ne "khoa-hoc-2") { throw "Slug duy nhất thất bại" }
  if (-not (Test-HttpsUrl "https://example.com/cover.jpg") -or (Test-HttpsUrl "http://example.com")) { throw "Kiểm tra HTTPS thất bại" }
  if ((Normalize-GoogleAccessEmail " User@Gmail.com ") -ne "user@gmail.com") { throw "Chuẩn hóa email Google thất bại" }
  if (Normalize-GoogleAccessEmail 'Name <user@gmail.com>') { throw "Không chặn email dạng display name" }
  if (Normalize-GoogleAccessEmail 'user+tag@gmail.com') { throw "Không chặn alias +tag" }
  if (Normalize-GoogleAccessEmail 'user+tag@gmail.com" --plan full') { throw "Không chặn ký tự dòng lệnh trong email" }
  $folderId = "1AbCdEfGhIjKlMnOpQrStUvWxYz"
  if ((Resolve-DriveFolderId "https://drive.google.com/drive/u/0/folders/${folderId}?usp=sharing") -ne $folderId) { throw "Chuẩn hóa URL Drive thất bại" }
  if ((Resolve-DriveFolderId $folderId) -ne $folderId -or (Resolve-DriveFolderId "https://example.com/drive/folders/$folderId")) { throw "Kiểm tra folder Drive thất bại" }
  if ((Get-CourseDeliveryMode ([pscustomobject]@{ streamAvailable = $true })) -ne "STREAM") { throw "Tương thích streamAvailable thất bại" }
  if ((Get-CourseDeliveryMode ([pscustomobject]@{ deliveryMode = "DRIVE"; streamAvailable = $false })) -ne "DRIVE") { throw "deliveryMode không được ưu tiên" }
  if (-not (Get-CourseValidationError "A" "" 100 "full" $false $true $false "NON-STREAM" $false "" "" "")) { throw "Kiểm tra quyền công khai thất bại" }
  if (-not (Get-CourseValidationError "A" "" 100 "full" $true $true $true "NON-STREAM" $false "" "" "")) { throw "Kiểm tra thanh toán NON-STREAM thất bại" }
  if (Get-CourseValidationError "A" "" 100 "full" $true $true $false "STREAM" $false "" "" "") { throw "Draft STREAM không thể lưu" }
  if (-not (Get-CourseValidationError "A" "" 100 "full" $true $true $true "STREAM" $false "" "" "")) { throw "Kiểm tra bài HLS STREAM thanh toán thất bại" }
  if (-not (Get-CourseValidationError "A" "" 100 "full" $true $true $false "DRIVE" $false "invalid" "" "")) { throw "Kiểm tra thư mục DRIVE thất bại" }
  if (Get-CourseValidationError "A" "" 100 "full" $true $true $true "DRIVE" $false $folderId "" "") { throw "Khóa DRIVE hợp lệ không thể mở bán" }
  if (Get-CourseValidationError "A" "" 100 "full" $true $true $true "STREAM" $true "" "" "") { throw "Khóa STREAM hợp lệ không thể mở bán" }
  if (Get-CourseValidationError "A" "" 0 "full" $true $true $false "NON-STREAM" $false "" "" "") { throw "Khóa NON-STREAM hợp lệ không thể công khai" }

  $deleteCatalog = [pscustomobject][ordered]@{
    courses = @(
      [pscustomobject][ordered]@{ id = "keep"; title = "Giữ lại" },
      [pscustomobject][ordered]@{ id = "remove"; title = "Xóa" }
    )
  }
  $deleteDelivery = [pscustomobject][ordered]@{ driveFolders = [pscustomobject][ordered]@{} }
  Set-PrivateDriveFolder $deleteDelivery "keep" $folderId
  Set-PrivateDriveFolder $deleteDelivery "remove" "1ZyXwVuTsRqPoNmLkJiHgFeDcBa"
  $removed = Remove-CourseData $deleteCatalog $deleteDelivery "remove"
  if ($removed.id -ne "remove" -or @($deleteCatalog.courses).Count -ne 1 -or $deleteCatalog.courses[0].id -ne "keep") { throw "Xóa khóa khỏi catalog thất bại" }
  if (Get-PrivateDriveFolder "remove" $deleteDelivery) { throw "Không xóa cấu hình Drive riêng của khóa" }
  if ((Get-PrivateDriveFolder "keep" $deleteDelivery) -ne $folderId) { throw "Xóa nhầm cấu hình Drive của khóa khác" }
  [void](Remove-CourseData $deleteCatalog $deleteDelivery "keep")
  $deleteRoundTrip = $deleteCatalog | ConvertTo-Json -Depth 10 | ConvertFrom-Json
  if (@($deleteRoundTrip.courses).Count -ne 0) { throw "Catalog rỗng không giữ được mảng courses" }
  $duplicateCatalog = [pscustomobject][ordered]@{
    courses = @([pscustomobject]@{ id = "duplicate" }, [pscustomobject]@{ id = "duplicate" })
  }
  $duplicateRejected = $false
  try {
    [void](Remove-CourseData $duplicateCatalog ([pscustomobject]@{ driveFolders = [pscustomobject]@{} }) "duplicate")
  } catch {
    if ($_.Exception.Message -notmatch "trùng mã") { throw }
    $duplicateRejected = $true
  }
  if (-not $duplicateRejected) { throw "Không chặn catalog trùng mã" }
  if (@($duplicateCatalog.courses).Count -ne 2) { throw "Đã xóa dữ liệu khi catalog trùng mã" }

  $directory = Join-Path ([IO.Path]::GetTempPath()) ("nixart-manager-{0}" -f [Guid]::NewGuid().ToString("N"))
  [IO.Directory]::CreateDirectory($directory) | Out-Null
  $path = Join-Path $directory "catalog.json"
  try {
    $sample = [pscustomobject][ordered]@{ name = "NIXART"; unknown = @{ keep = $true }; courses = @() }
    Save-CatalogAtomically $sample $path
    $bytes = [IO.File]::ReadAllBytes($path)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) { throw "JSON có BOM" }
    $roundTrip = Get-CatalogSnapshot $path
    if (-not $roundTrip.Catalog.unknown.keep) { throw "Không giữ được field lạ" }
    $updated = [pscustomobject][ordered]@{ name = "NIXART"; unknown = @{ keep = "updated" }; courses = @() }
    Save-CatalogAtomically $updated $path
    if (-not [IO.File]::Exists("$path.manager-backup")) { throw "Không tạo được backup" }
    if ((Get-CatalogSnapshot $path).Catalog.unknown.keep -ne "updated") { throw "Atomic replace thất bại" }
    if (-not (Get-CatalogSnapshot "$path.manager-backup").Catalog.unknown.keep) { throw "Backup không hợp lệ" }
    $third = [pscustomobject][ordered]@{ name = "NIXART"; unknown = @{ keep = "third" }; courses = @() }
    Save-CatalogAtomically $third $path
    if ((Get-CatalogSnapshot $path).Catalog.unknown.keep -ne "third") { throw "Không ghi đè atomic lần hai" }
    if ((Get-CatalogSnapshot "$path.manager-backup").Catalog.unknown.keep -ne "updated") { throw "Backup lần hai không hợp lệ" }
    $deliveryPath = Join-Path $directory "delivery.private.json"
    $delivery = [pscustomobject][ordered]@{ driveFolders = [pscustomobject][ordered]@{} }
    Set-PrivateDriveFolder $delivery "khoa-hoc" $folderId
    Save-CatalogAtomically $delivery $deliveryPath
    $deliveryRoundTrip = Get-DeliverySnapshot $deliveryPath
    if ((Get-PrivateDriveFolder "khoa-hoc" $deliveryRoundTrip.Delivery) -ne $folderId) { throw "Không lưu được cấu hình Drive riêng tư" }
  } finally {
    if ([IO.Directory]::Exists($directory)) { [IO.Directory]::Delete($directory, $true) }
  }
  Write-Host "SELF-TEST OK"
}

if ($SelfTest) {
  Invoke-SelfTest
  return
}

[Windows.Forms.Application]::EnableVisualStyles()

$createdNew = $false
$mutexName = "Local\NixartCourseManager-" + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($script:RepoRoot)).Replace("=", "").Replace("/", "_").Replace("+", "-")
$mutex = New-Object Threading.Mutex($true, $mutexName, [ref]$createdNew)
if (-not $createdNew) {
  [Windows.Forms.MessageBox]::Show("Nixart Course Manager đang mở ở cửa sổ khác.", "Nixart", "OK", "Information") | Out-Null
  $mutex.Dispose()
  return
}

$bg = [Drawing.Color]::FromArgb(10, 10, 11)
$surface = [Drawing.Color]::FromArgb(20, 20, 22)
$surface2 = [Drawing.Color]::FromArgb(28, 28, 31)
$border = [Drawing.Color]::FromArgb(42, 42, 46)
$text = [Drawing.Color]::FromArgb(245, 245, 246)
$muted = [Drawing.Color]::FromArgb(161, 161, 166)
$success = [Drawing.Color]::FromArgb(94, 201, 138)
$danger = [Drawing.Color]::FromArgb(255, 99, 99)
$discord = [Drawing.Color]::FromArgb(88, 101, 242)
$accent = $discord

$form = New-Object Windows.Forms.Form
$form.Text = "Nixart Course Manager"
$form.StartPosition = "CenterScreen"
$form.ClientSize = New-Object Drawing.Size(1280, 820)
$form.MinimumSize = New-Object Drawing.Size(1160, 760)
$form.BackColor = $bg
$form.ForeColor = $text
$form.Font = New-Object Drawing.Font("Segoe UI", 10)

$header = New-Object Windows.Forms.Panel
$header.Dock = "Top"
$header.Height = 76
$header.BackColor = $bg
$form.Controls.Add($header)

$brandMark = New-Object Windows.Forms.Label
$brandMark.Text = "NX"
$brandMark.Location = New-Object Drawing.Point(20, 14)
$brandMark.Size = New-Object Drawing.Size(48, 48)
$brandMark.BackColor = $discord
$brandMark.ForeColor = $text
$brandMark.TextAlign = "MiddleCenter"
$brandMark.Font = New-Object Drawing.Font("Segoe UI Semibold", 13)
$header.Controls.Add($brandMark)

$heading = New-Object Windows.Forms.Label
$heading.Text = "QUẢN LÝ KHÓA HỌC"
$heading.Font = New-Object Drawing.Font("Segoe UI Semibold", 14)
$heading.AutoSize = $true
$heading.Location = New-Object Drawing.Point(84, 13)
$header.Controls.Add($heading)

$subheading = New-Object Windows.Forms.Label
$subheading.Text = "Nixart catalog  /  Web & Discord publishing console"
$subheading.ForeColor = $muted
$subheading.AutoSize = $true
$subheading.Location = New-Object Drawing.Point(85, 42)
$header.Controls.Add($subheading)

$statusLabel = New-Object Windows.Forms.Label
$statusLabel.Text = "SẴN SÀNG  ·  Chưa có thay đổi"
$statusLabel.Location = New-Object Drawing.Point(650, 20)
$statusLabel.Size = New-Object Drawing.Size(230, 36)
$statusLabel.Anchor = "Top, Right"
$statusLabel.BackColor = $surface2
$statusLabel.ForeColor = $muted
$statusLabel.BorderStyle = "FixedSingle"
$statusLabel.TextAlign = "MiddleCenter"
$statusLabel.AutoEllipsis = $true
$statusLabel.Font = New-Object Drawing.Font("Segoe UI Semibold", 8.5)
$header.Controls.Add($statusLabel)

$accessButton = New-Object Windows.Forms.Button
$accessButton.Text = "CẤP QUYỀN EMAIL"
$accessButton.Size = New-Object Drawing.Size(160, 38)
$accessButton.Location = New-Object Drawing.Point(894, 19)
$accessButton.Anchor = "Top, Right"
$accessButton.FlatStyle = "Flat"
$accessButton.BackColor = $surface2
$accessButton.ForeColor = $success
$accessButton.Font = New-Object Drawing.Font("Segoe UI Semibold", 8.5)
$accessButton.FlatAppearance.BorderColor = $success
$accessButton.FlatAppearance.MouseOverBackColor = [Drawing.Color]::FromArgb(26, 49, 38)
$header.Controls.Add($accessButton)

$syncButton = New-Object Windows.Forms.Button
$syncButton.Text = "ĐỒNG BỘ DISCORD"
$syncButton.Size = New-Object Drawing.Size(190, 38)
$syncButton.Location = New-Object Drawing.Point(1068, 19)
$syncButton.Anchor = "Top, Right"
$syncButton.FlatStyle = "Flat"
$syncButton.BackColor = $discord
$syncButton.ForeColor = $text
$syncButton.Font = New-Object Drawing.Font("Segoe UI Semibold", 9)
$syncButton.FlatAppearance.BorderColor = $discord
$syncButton.FlatAppearance.MouseOverBackColor = [Drawing.Color]::FromArgb(105, 116, 245)
$header.Controls.Add($syncButton)

$headerBorder = New-Object Windows.Forms.Panel
$headerBorder.Dock = "Bottom"
$headerBorder.Height = 1
$headerBorder.BackColor = $border
$header.Controls.Add($headerBorder)

$outputGroup = New-Object Windows.Forms.Panel
$outputGroup.Dock = "Bottom"
$outputGroup.Height = 150
$outputGroup.BackColor = $surface
$outputGroup.ForeColor = $text
$outputGroup.Padding = New-Object Windows.Forms.Padding(14, 31, 14, 12)
$form.Controls.Add($outputGroup)

$logTitle = New-Object Windows.Forms.Label
$logTitle.Text = "NHẬT KÝ HỆ THỐNG"
$logTitle.ForeColor = $muted
$logTitle.Font = New-Object Drawing.Font("Segoe UI Semibold", 8)
$logTitle.AutoSize = $true
$logTitle.Location = New-Object Drawing.Point(15, 8)
$outputGroup.Controls.Add($logTitle)

$outputBox = New-Object Windows.Forms.RichTextBox
$outputBox.Dock = "Fill"
$outputBox.ReadOnly = $true
$outputBox.BackColor = $bg
$outputBox.ForeColor = $text
$outputBox.BorderStyle = "None"
$outputBox.Font = New-Object Drawing.Font("Cascadia Mono", 9)
$outputGroup.Controls.Add($outputBox)
$outputBox.BringToFront()

$split = New-Object Windows.Forms.SplitContainer
$split.Dock = "Fill"
$split.SplitterWidth = 10
$split.BackColor = $bg
$split.Panel1.Padding = New-Object Windows.Forms.Padding(18, 12, 5, 12)
$split.Panel2.Padding = New-Object Windows.Forms.Padding(5, 12, 18, 12)
$form.Controls.Add($split)
$split.SplitterDistance = 610
$split.Panel1MinSize = 500
$split.Panel2MinSize = 500
$split.BringToFront()

$listGroup = New-Object Windows.Forms.Panel
$listGroup.Dock = "Fill"
$listGroup.Padding = New-Object Windows.Forms.Padding(1)
$listGroup.BackColor = $border
$listGroup.ForeColor = $text
$split.Panel1.Controls.Add($listGroup)

$listSurface = New-Object Windows.Forms.Panel
$listSurface.Dock = "Fill"
$listSurface.Padding = New-Object Windows.Forms.Padding(0, 58, 0, 0)
$listSurface.BackColor = $surface
$listGroup.Controls.Add($listSurface)

$listToolbar = New-Object Windows.Forms.Panel
$listToolbar.Location = New-Object Drawing.Point(1, 1)
$listToolbar.Size = New-Object Drawing.Size(584, 58)
$listToolbar.Anchor = "Top, Left, Right"
$listToolbar.BackColor = $surface
$listGroup.Controls.Add($listToolbar)
$listToolbar.BringToFront()

$catalogTitle = New-Object Windows.Forms.Label
$catalogTitle.Text = "CATALOG"
$catalogTitle.Font = New-Object Drawing.Font("Segoe UI Semibold", 10)
$catalogTitle.AutoSize = $true
$catalogTitle.Location = New-Object Drawing.Point(14, 10)
$listToolbar.Controls.Add($catalogTitle)

$catalogSubtitle = New-Object Windows.Forms.Label
$catalogSubtitle.Text = "Chọn một khóa để chỉnh sửa"
$catalogSubtitle.ForeColor = $muted
$catalogSubtitle.Font = New-Object Drawing.Font("Segoe UI", 8)
$catalogSubtitle.AutoSize = $true
$catalogSubtitle.Location = New-Object Drawing.Point(15, 31)
$listToolbar.Controls.Add($catalogSubtitle)

$newButton = New-Object Windows.Forms.Button
$newButton.Text = "+  KHÓA MỚI"
$newButton.Size = New-Object Drawing.Size(128, 34)
$newButton.Location = New-Object Drawing.Point(299, 12)
$newButton.Anchor = "Top, Right"
$newButton.FlatStyle = "Flat"
$newButton.BackColor = $discord
$newButton.ForeColor = $text
$newButton.Font = New-Object Drawing.Font("Segoe UI Semibold", 8.5)
$newButton.FlatAppearance.BorderColor = $discord
$listToolbar.Controls.Add($newButton)

$deleteButton = New-Object Windows.Forms.Button
$deleteButton.Text = "XÓA BÀI ĐĂNG"
$deleteButton.Size = New-Object Drawing.Size(132, 34)
$deleteButton.Location = New-Object Drawing.Point(437, 12)
$deleteButton.Anchor = "Top, Right"
$deleteButton.FlatStyle = "Flat"
$deleteButton.BackColor = $surface
$deleteButton.ForeColor = $danger
$deleteButton.Font = New-Object Drawing.Font("Segoe UI Semibold", 8.5)
$deleteButton.FlatAppearance.BorderColor = $danger
$deleteButton.FlatAppearance.MouseOverBackColor = $surface2
$deleteButton.Enabled = $false
$listToolbar.Controls.Add($deleteButton)

$courseGrid = New-Object Windows.Forms.DataGridView
$courseGrid.Dock = "Fill"
$courseGrid.ReadOnly = $true
$courseGrid.AllowUserToAddRows = $false
$courseGrid.AllowUserToDeleteRows = $false
$courseGrid.AllowUserToResizeRows = $false
$courseGrid.AutoGenerateColumns = $false
$courseGrid.SelectionMode = "FullRowSelect"
$courseGrid.MultiSelect = $false
$courseGrid.RowHeadersVisible = $false
$courseGrid.BackgroundColor = $surface
$courseGrid.BorderStyle = "None"
$courseGrid.GridColor = $border
$courseGrid.EnableHeadersVisualStyles = $false
$courseGrid.ColumnHeadersDefaultCellStyle.BackColor = $surface2
$courseGrid.ColumnHeadersDefaultCellStyle.ForeColor = $text
$courseGrid.ColumnHeadersDefaultCellStyle.Font = New-Object Drawing.Font("Segoe UI Semibold", 8.5)
$courseGrid.ColumnHeadersDefaultCellStyle.Padding = New-Object Windows.Forms.Padding(6, 0, 6, 0)
$courseGrid.ColumnHeadersHeight = 40
$courseGrid.ColumnHeadersHeightSizeMode = "DisableResizing"
$courseGrid.DefaultCellStyle.BackColor = $surface
$courseGrid.DefaultCellStyle.ForeColor = $text
$courseGrid.DefaultCellStyle.Font = New-Object Drawing.Font("Segoe UI", 9)
$courseGrid.DefaultCellStyle.Padding = New-Object Windows.Forms.Padding(7, 0, 7, 0)
$courseGrid.DefaultCellStyle.SelectionBackColor = $discord
$courseGrid.DefaultCellStyle.SelectionForeColor = $text
$courseGrid.AlternatingRowsDefaultCellStyle.BackColor = $surface2
$courseGrid.RowTemplate.Height = 40
$courseGrid.ScrollBars = "Vertical"
$listSurface.Controls.Add($courseGrid)

foreach ($columnInfo in @(
  @{ Name = "Tên khóa học"; Width = 190 },
  @{ Name = "Giá"; Width = 82 },
  @{ Name = "Gói"; Width = 50 },
  @{ Name = "Cấu hình"; Width = 82 },
  @{ Name = "Quyền"; Width = 52 },
  @{ Name = "Web"; Width = 46 },
  @{ Name = "Mở bán"; Width = 58 }
)) {
  $column = New-Object Windows.Forms.DataGridViewTextBoxColumn
  $column.HeaderText = $columnInfo.Name
  $column.Width = $columnInfo.Width
  if ($columnInfo.Name -eq "Tên khóa học") { $column.AutoSizeMode = "Fill" }
  [void]$courseGrid.Columns.Add($column)
}

$editor = New-Object Windows.Forms.Panel
$editor.Dock = "Fill"
$editor.Padding = New-Object Windows.Forms.Padding(1)
$editor.BackColor = $border
$editor.ForeColor = $text
$split.Panel2.Controls.Add($editor)

$editorSurface = New-Object Windows.Forms.Panel
$editorSurface.Dock = "Fill"
$editorSurface.Padding = New-Object Windows.Forms.Padding(0, 62, 0, 0)
$editorSurface.BackColor = $surface
$editor.Controls.Add($editorSurface)

$editorHeader = New-Object Windows.Forms.Panel
$editorHeader.Location = New-Object Drawing.Point(1, 1)
$editorHeader.Size = New-Object Drawing.Size(632, 62)
$editorHeader.Anchor = "Top, Left, Right"
$editorHeader.BackColor = $surface
$editor.Controls.Add($editorHeader)
$editorHeader.BringToFront()

$editorTitle = New-Object Windows.Forms.Label
$editorTitle.Text = "THÔNG TIN KHÓA HỌC"
$editorTitle.Font = New-Object Drawing.Font("Segoe UI Semibold", 10)
$editorTitle.AutoSize = $true
$editorTitle.Location = New-Object Drawing.Point(16, 9)
$editorHeader.Controls.Add($editorTitle)

$idLabel = New-Object Windows.Forms.Label
$idLabel.Text = "MÃ KHÓA HỌC  ·  SẼ TẠO KHI LƯU"
$idLabel.ForeColor = $muted
$idLabel.Location = New-Object Drawing.Point(17, 32)
$idLabel.Size = New-Object Drawing.Size(320, 20)
$idLabel.AutoEllipsis = $true
$idLabel.Font = New-Object Drawing.Font("Segoe UI", 8)
$editorHeader.Controls.Add($idLabel)

$cancelButton = New-Object Windows.Forms.Button
$cancelButton.Text = "HỦY"
$cancelButton.Location = New-Object Drawing.Point(365, 13)
$cancelButton.Size = New-Object Drawing.Size(88, 36)
$cancelButton.Anchor = "Top, Right"
$cancelButton.FlatStyle = "Flat"
$cancelButton.BackColor = $surface
$cancelButton.ForeColor = $text
$cancelButton.Font = New-Object Drawing.Font("Segoe UI Semibold", 8.5)
$cancelButton.FlatAppearance.BorderColor = $border
$editorHeader.Controls.Add($cancelButton)

$saveButton = New-Object Windows.Forms.Button
$saveButton.Text = "THÊM KHÓA HỌC"
$saveButton.Location = New-Object Drawing.Point(463, 13)
$saveButton.Size = New-Object Drawing.Size(154, 36)
$saveButton.Anchor = "Top, Right"
$saveButton.FlatStyle = "Flat"
$saveButton.BackColor = $accent
$saveButton.ForeColor = $text
$saveButton.Font = New-Object Drawing.Font("Segoe UI Semibold", 8.5)
$saveButton.FlatAppearance.BorderColor = $accent
$saveButton.FlatAppearance.MouseOverBackColor = [Drawing.Color]::FromArgb(105, 116, 245)
$editorHeader.Controls.Add($saveButton)

$editorBody = New-Object Windows.Forms.Panel
$editorBody.Dock = "Fill"
$editorBody.BackColor = $surface
$editorBody.AutoScroll = $true
$editorSurface.Controls.Add($editorBody)

function Add-EditorLabel {
  param([string]$Caption, [int]$Top, [int]$Left = 18)
  $label = New-Object Windows.Forms.Label
  $label.Text = $Caption
  $label.AutoSize = $true
$label.ForeColor = $muted
$label.Font = New-Object Drawing.Font("Segoe UI Semibold", 8)
  $label.Location = New-Object Drawing.Point($Left, $Top)
  $editorBody.Controls.Add($label)
}

function New-EditorTextBox {
  param([int]$Top, [int]$Height = 28, [bool]$Multiline = $false)
  $box = New-Object Windows.Forms.TextBox
  $box.Location = New-Object Drawing.Point(18, $Top)
  $box.Size = New-Object Drawing.Size(598, $Height)
  $box.Anchor = "Top, Left, Right"
  $box.BackColor = $surface2
  $box.ForeColor = $text
  $box.BorderStyle = "FixedSingle"
  $box.Multiline = $Multiline
  $editorBody.Controls.Add($box)
  $box
}

Add-EditorLabel "TÊN KHÓA HỌC *" 8
$titleBox = New-EditorTextBox 25 30
$titleBox.MaxLength = 100

Add-EditorLabel "MÔ TẢ" 60
$descriptionBox = New-EditorTextBox 77 54 $true
$descriptionBox.MaxLength = 4000
$descriptionBox.ScrollBars = "Vertical"

Add-EditorLabel "URL ẢNH BÌA (HTTPS)" 139
$imageUrlBox = New-EditorTextBox 156 30
$imageUrlBox.MaxLength = 2000

Add-EditorLabel "LINK PREVIEW KHÓA HỌC (HTTPS)" 194
$previewUrlBox = New-EditorTextBox 211 30
$previewUrlBox.MaxLength = 512

Add-EditorLabel "GIÁ BÁN (VNĐ)" 249
$priceBox = New-Object Windows.Forms.NumericUpDown
$priceBox.Location = New-Object Drawing.Point(18, 266)
$priceBox.Size = New-Object Drawing.Size(286, 30)
$priceBox.Maximum = 2000000000
$priceBox.DecimalPlaces = 0
$priceBox.Increment = 10000
$priceBox.ThousandsSeparator = $true
$priceBox.BackColor = $surface2
$priceBox.ForeColor = $text
$editorBody.Controls.Add($priceBox)

Add-EditorLabel "THUỘC GÓI" 249 318
$planBox = New-Object Windows.Forms.ComboBox
$planBox.Location = New-Object Drawing.Point(318, 266)
$planBox.Size = New-Object Drawing.Size(298, 30)
$planBox.Anchor = "Top, Left, Right"
$planBox.DropDownStyle = "DropDownList"
$planBox.BackColor = $surface2
$planBox.ForeColor = $text
[void]$planBox.Items.AddRange(@("basic", "full"))
$planBox.SelectedItem = "full"
$editorBody.Controls.Add($planBox)

Add-EditorLabel "HÌNH THỨC HỌC" 304
$deliveryBox = New-Object Windows.Forms.ComboBox
$deliveryBox.Location = New-Object Drawing.Point(18, 321)
$deliveryBox.Size = New-Object Drawing.Size(598, 30)
$deliveryBox.Anchor = "Top, Left, Right"
$deliveryBox.DropDownStyle = "DropDownList"
$deliveryBox.BackColor = $surface2
$deliveryBox.ForeColor = $text
[void]$deliveryBox.Items.AddRange(@(
  "NON-STREAM — chưa có cách giao nội dung",
  "DRIVE — thêm email vào thư mục Google Drive",
  "STREAM — học trực tiếp trên web"
))
$deliveryBox.SelectedIndex = 0
$editorBody.Controls.Add($deliveryBox)

Add-EditorLabel "GOOGLE DRIVE FOLDER ID HOẶC URL THƯ MỤC" 359
$driveFolderBox = New-EditorTextBox 376 30
$driveFolderBox.MaxLength = 2000
$driveFolderBox.Enabled = $false
$deliveryBox.Add_SelectedIndexChanged({
  $driveFolderBox.Enabled = $deliveryBox.SelectedIndex -eq 1
})

$rightsBox = New-Object Windows.Forms.CheckBox
$rightsBox.Text = "Tôi xác nhận có quyền phân phối khóa học"
$rightsBox.AutoSize = $true
$rightsBox.Location = New-Object Drawing.Point(18, 420)
$rightsBox.FlatStyle = "Flat"
$editorBody.Controls.Add($rightsBox)

$publishedBox = New-Object Windows.Forms.CheckBox
$publishedBox.Text = "Công khai khóa học trên web"
$publishedBox.AutoSize = $true
$publishedBox.Location = New-Object Drawing.Point(18, 444)
$publishedBox.FlatStyle = "Flat"
$editorBody.Controls.Add($publishedBox)

$saleBox = New-Object Windows.Forms.CheckBox
$saleBox.Text = "Mở thanh toán (cần DRIVE hợp lệ hoặc STREAM có bài)"
$saleBox.AutoSize = $true
$saleBox.Location = New-Object Drawing.Point(18, 468)
$saleBox.FlatStyle = "Flat"
$editorBody.Controls.Add($saleBox)

function Write-Log {
  param([string]$Message)
  $outputBox.AppendText(("[{0}] {1}{2}" -f (Get-Date -Format "HH:mm:ss"), $Message, [Environment]::NewLine))
  $outputBox.SelectionStart = $outputBox.TextLength
  $outputBox.ScrollToCaret()
}

function Invoke-DiscordCourseDelete {
  param([string]$CourseId)

  if ($CourseId -cnotmatch "^[a-z0-9][a-z0-9_-]{0,79}$") { throw "Mã khóa học cần xóa không hợp lệ." }
  $startInfo = New-Object Diagnostics.ProcessStartInfo
  $startInfo.FileName = (Get-Command node.exe -ErrorAction Stop).Source
  $startInfo.Arguments = "--env-file-if-exists=.env scripts/sync-discord-courses.js --delete-course $CourseId"
  $startInfo.WorkingDirectory = $script:RepoRoot
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.StandardOutputEncoding = [Text.Encoding]::UTF8
  $startInfo.StandardErrorEncoding = [Text.Encoding]::UTF8

  $process = New-Object Diagnostics.Process
  try {
    $process.StartInfo = $startInfo
    if (-not $process.Start()) { throw "Không thể khởi chạy tiến trình xóa bài Discord." }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $stdout = $stdoutTask.Result.Trim()
    $stderr = $stderrTask.Result.Trim()
    $exitCode = $process.ExitCode
  } finally {
    $process.Dispose()
  }
  if ($exitCode -ne 0) {
    if ($stderr) { throw $stderr }
    throw "Discord không thể xóa bài đăng (mã $exitCode)."
  }
  $stdout
}

function Get-GoogleAccessOptions {
  $options = @()
  foreach ($planId in @("full", "basic")) {
    $plan = @($script:Catalog.plans) | Where-Object { [string]$_.id -ceq $planId } | Select-Object -First 1
    if ($null -ne $plan) {
      $days = [Math]::Max(1, [int]$plan.durationDays)
      $options += [pscustomobject]@{
        Label = "Gói $([string]$plan.title) · $days ngày"
        Kind = "plan"
        Value = $planId
      }
    }
  }
  foreach ($course in @($script:Catalog.courses)) {
    $courseId = [string]$course.id
    $hasPublishedLesson = @($course.lessons | Where-Object { $_.published -eq $true }).Count -gt 0
    if ($courseId -cmatch '^[a-z0-9][a-z0-9_-]{0,79}$' -and
        $course.published -eq $true -and $course.rightsVerified -eq $true -and
        (Get-CourseDeliveryMode $course) -eq "STREAM" -and $hasPublishedLesson) {
      $options += [pscustomobject]@{
        Label = "Khóa · $([string]$course.title) · $courseId"
        Kind = "course"
        Value = $courseId
      }
    }
  }
  @($options)
}

function Invoke-GoogleAccessGrant {
  param([string]$Email, [string]$Kind, [string]$Value)

  $email = Normalize-GoogleAccessEmail $Email
  if (-not $email) { throw "Hãy nhập đúng một email Google hợp lệ." }
  if ($Kind -eq "plan") {
    if (@("basic", "full") -notcontains $Value) { throw "Gói truy cập không hợp lệ." }
    $selector = "--plan"
  } elseif ($Kind -eq "course") {
    if ($Value -cnotmatch '^[a-z0-9][a-z0-9_-]{0,79}$') { throw "Mã khóa học không hợp lệ." }
    $selector = "--course"
  } else {
    throw "Loại quyền truy cập không hợp lệ."
  }

  $startInfo = New-Object Diagnostics.ProcessStartInfo
  $startInfo.FileName = (Get-Command node.exe -ErrorAction Stop).Source
  $startInfo.Arguments = '--env-file-if-exists=.env scripts/grant-google-access.js --email "{0}" {1} {2}' -f $email, $selector, $Value
  $startInfo.WorkingDirectory = $script:RepoRoot
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.StandardOutputEncoding = [Text.Encoding]::UTF8
  $startInfo.StandardErrorEncoding = [Text.Encoding]::UTF8

  $process = New-Object Diagnostics.Process
  try {
    $process.StartInfo = $startInfo
    if (-not $process.Start()) { throw "Không thể khởi chạy tiến trình cấp quyền." }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $stdout = $stdoutTask.Result.Trim()
    $stderr = $stderrTask.Result.Trim()
    $exitCode = $process.ExitCode
  } finally {
    $process.Dispose()
  }
  if ($exitCode -ne 0) {
    if ($stderr) { throw $stderr }
    throw "Không thể cấp quyền (mã $exitCode)."
  }
  if ($stdout) { return $stdout }
  "Đã cấp quyền cho $email."
}

function Clear-Editor {
  $script:EditingCourseId = ""
  $titleBox.Clear()
  $descriptionBox.Clear()
  $imageUrlBox.Clear()
  $previewUrlBox.Clear()
  $priceBox.Value = 0
  $planBox.SelectedItem = "full"
  $deliveryBox.SelectedIndex = 0
  $driveFolderBox.Clear()
  $rightsBox.Checked = $false
  $publishedBox.Checked = $false
  $saleBox.Checked = $false
  $idLabel.Text = "MÃ KHÓA HỌC  ·  SẼ TẠO KHI LƯU"
  $saveButton.Text = "THÊM KHÓA HỌC"
  $deleteButton.Enabled = $false
  $courseGrid.ClearSelection()
  [void]$titleBox.Focus()
}

function Refresh-CourseList {
  param([string]$SelectId = "")

  $snapshot = Get-CatalogSnapshot
  $deliverySnapshot = Get-DeliverySnapshot
  $script:Catalog = $snapshot.Catalog
  $script:CatalogFingerprint = $snapshot.Fingerprint
  $script:Delivery = $deliverySnapshot.Delivery
  $script:DeliveryFingerprint = $deliverySnapshot.Fingerprint
  $courseGrid.Rows.Clear()
  foreach ($course in @($script:Catalog.courses)) {
    $price = if ([decimal]$course.price -gt 0) { "{0:N0}đ" -f [decimal]$course.price } else { "—" }
    $hasPublishedLesson = @($course.lessons | Where-Object { $_.published -eq $true }).Count -gt 0
    $deliveryMode = Get-CourseDeliveryMode $course
    $deliveryReady = switch ($deliveryMode) {
      "DRIVE" { [bool](Resolve-DriveFolderId (Get-PrivateDriveFolder ([string]$course.id))) }
      "STREAM" { $hasPublishedLesson }
      default { $false }
    }
    $saleReady = $course.forumVisible -eq $true -and $course.published -eq $true -and $course.saleEnabled -eq $true -and $course.rightsVerified -eq $true -and
      [decimal]$course.price -gt 0 -and $deliveryReady
    $rowIndex = $courseGrid.Rows.Add(
      [string]$course.title,
      $price,
      [string]$course.planTier,
      $deliveryMode,
      $(if ($course.rightsVerified -eq $true) { "Có" } else { "Chưa" }),
      $(if ($course.published -eq $true) { "Có" } else { "Chưa" }),
      $(if ($saleReady) { "Có" } else { "Chưa" })
    )
    $courseGrid.Rows[$rowIndex].Tag = [string]$course.id
  }
  $courseGrid.ClearSelection()
  if ($SelectId) {
    foreach ($row in $courseGrid.Rows) {
      if ([string]$row.Tag -eq $SelectId) {
        $row.Selected = $true
        $courseGrid.CurrentCell = $row.Cells[0]
        break
      }
    }
  }
}

function Load-CourseIntoEditor {
  param([string]$Id)

  $course = @($script:Catalog.courses) | Where-Object { [string]$_.id -eq $Id } | Select-Object -First 1
  if ($null -eq $course) { return }
  $script:EditingCourseId = [string]$course.id
  $titleBox.Text = [string]$course.title
  $descriptionBox.Text = [string]$course.description
  $imageUrlBox.Text = [string]$course.imageUrl
  $previewUrlBox.Text = [string]$course.previewUrl
  $price = [decimal]$course.price
  if ($price -lt $priceBox.Minimum) { $price = $priceBox.Minimum }
  if ($price -gt $priceBox.Maximum) { $price = $priceBox.Maximum }
  $priceBox.Value = $price
  $planBox.SelectedItem = if (@("basic", "full") -contains [string]$course.planTier) { [string]$course.planTier } else { "full" }
  $deliveryMode = Get-CourseDeliveryMode $course
  $deliveryBox.SelectedIndex = switch ($deliveryMode) { "DRIVE" { 1 } "STREAM" { 2 } default { 0 } }
  $driveFolderBox.Text = Get-PrivateDriveFolder ([string]$course.id)
  $rightsBox.Checked = $course.rightsVerified -eq $true
  $publishedBox.Checked = $course.published -eq $true
  $saleBox.Checked = $course.saleEnabled -eq $true
  $idLabel.Text = "MÃ KHÓA HỌC  ·  $($script:EditingCourseId)"
  $saveButton.Text = "LƯU THAY ĐỔI"
  $deleteButton.Enabled = $true
}

$newButton.Add_Click({ Clear-Editor })
$cancelButton.Add_Click({ Clear-Editor })
$accessButton.Add_Click({
  if ($script:SyncRunning) { return }
  $options = @(Get-GoogleAccessOptions)
  if ($options.Count -eq 0) {
    [Windows.Forms.MessageBox]::Show("Chưa có gói hoặc khóa STREAM đủ điều kiện để cấp quyền.", "Chưa có quyền để cấp", "OK", "Information") | Out-Null
    return
  }

  $dialog = New-Object Windows.Forms.Form
  $dialog.Text = "Cấp quyền truy cập Google"
  $dialog.StartPosition = "CenterParent"
  $dialog.FormBorderStyle = "FixedDialog"
  $dialog.MaximizeBox = $false
  $dialog.MinimizeBox = $false
  $dialog.ShowInTaskbar = $false
  $dialog.ClientSize = New-Object Drawing.Size(590, 310)
  $dialog.BackColor = $bg
  $dialog.ForeColor = $text
  $dialog.Font = New-Object Drawing.Font("Segoe UI", 10)

  $accessTitle = New-Object Windows.Forms.Label
  $accessTitle.Text = "CẤP QUYỀN HỌC"
  $accessTitle.Font = New-Object Drawing.Font("Segoe UI Semibold", 14)
  $accessTitle.AutoSize = $true
  $accessTitle.Location = New-Object Drawing.Point(22, 18)
  $dialog.Controls.Add($accessTitle)

  $accessCopy = New-Object Windows.Forms.Label
  $accessCopy.Text = "Dán email chính dùng để đăng nhập Google (không dùng alias +tag)."
  $accessCopy.ForeColor = $muted
  $accessCopy.AutoSize = $true
  $accessCopy.Location = New-Object Drawing.Point(23, 49)
  $dialog.Controls.Add($accessCopy)

  $accessEmailLabel = New-Object Windows.Forms.Label
  $accessEmailLabel.Text = "EMAIL GOOGLE"
  $accessEmailLabel.ForeColor = $muted
  $accessEmailLabel.AutoSize = $true
  $accessEmailLabel.Location = New-Object Drawing.Point(23, 82)
  $dialog.Controls.Add($accessEmailLabel)

  $accessEmailBox = New-Object Windows.Forms.TextBox
  $accessEmailBox.Location = New-Object Drawing.Point(26, 104)
  $accessEmailBox.Size = New-Object Drawing.Size(538, 30)
  $accessEmailBox.BackColor = $surface2
  $accessEmailBox.ForeColor = $text
  $accessEmailBox.BorderStyle = "FixedSingle"
  $accessEmailBox.MaxLength = 254
  $dialog.Controls.Add($accessEmailBox)

  $accessScopeLabel = New-Object Windows.Forms.Label
  $accessScopeLabel.Text = "PHẠM VI QUYỀN"
  $accessScopeLabel.ForeColor = $muted
  $accessScopeLabel.AutoSize = $true
  $accessScopeLabel.Location = New-Object Drawing.Point(23, 145)
  $dialog.Controls.Add($accessScopeLabel)

  $accessScopeBox = New-Object Windows.Forms.ComboBox
  $accessScopeBox.Location = New-Object Drawing.Point(26, 168)
  $accessScopeBox.Size = New-Object Drawing.Size(538, 32)
  $accessScopeBox.DropDownStyle = "DropDownList"
  $accessScopeBox.BackColor = $surface2
  $accessScopeBox.ForeColor = $text
  $accessScopeBox.DisplayMember = "Label"
  foreach ($option in $options) { [void]$accessScopeBox.Items.Add($option) }
  $accessScopeBox.SelectedIndex = 0
  $dialog.Controls.Add($accessScopeBox)

  $accessHint = New-Object Windows.Forms.Label
  $accessHint.ForeColor = $muted
  $accessHint.Size = New-Object Drawing.Size(538, 36)
  $accessHint.Location = New-Object Drawing.Point(23, 207)
  $dialog.Controls.Add($accessHint)
  $updateAccessHint = {
    $selected = $accessScopeBox.SelectedItem
    $accessHint.Text = if ($null -ne $selected -and $selected.Kind -eq "plan") {
      "Gói tháng bắt đầu từ lúc cấp; cấp lại sẽ cộng thêm thời hạn. Workspace phải đăng nhập Google một lần trước."
    } else {
      "Quyền khóa học không hết hạn. Gmail có thể cấp trước lần đăng nhập đầu tiên."
    }
  }
  $accessScopeBox.Add_SelectedIndexChanged($updateAccessHint)
  & $updateAccessHint

  $closeAccessButton = New-Object Windows.Forms.Button
  $closeAccessButton.Text = "HỦY"
  $closeAccessButton.Size = New-Object Drawing.Size(110, 36)
  $closeAccessButton.Location = New-Object Drawing.Point(334, 256)
  $closeAccessButton.FlatStyle = "Flat"
  $closeAccessButton.BackColor = $surface
  $closeAccessButton.ForeColor = $muted
  $closeAccessButton.FlatAppearance.BorderColor = $border
  $closeAccessButton.DialogResult = [Windows.Forms.DialogResult]::Cancel
  $dialog.Controls.Add($closeAccessButton)

  $grantAccessButton = New-Object Windows.Forms.Button
  $grantAccessButton.Text = "CẤP QUYỀN"
  $grantAccessButton.Size = New-Object Drawing.Size(120, 36)
  $grantAccessButton.Location = New-Object Drawing.Point(454, 256)
  $grantAccessButton.FlatStyle = "Flat"
  $grantAccessButton.BackColor = $success
  $grantAccessButton.ForeColor = $bg
  $grantAccessButton.Font = New-Object Drawing.Font("Segoe UI Semibold", 9)
  $grantAccessButton.FlatAppearance.BorderColor = $success
  $dialog.Controls.Add($grantAccessButton)

  $grantAccessButton.Add_Click({
    $email = Normalize-GoogleAccessEmail $accessEmailBox.Text
    $selected = $accessScopeBox.SelectedItem
    if (-not $email -or $null -eq $selected) {
      [Windows.Forms.MessageBox]::Show("Hãy nhập đúng một email Google và chọn phạm vi quyền.", "Dữ liệu chưa hợp lệ", "OK", "Warning") | Out-Null
      return
    }
    try {
      $dialog.UseWaitCursor = $true
      $accessEmailBox.Enabled = $false
      $accessScopeBox.Enabled = $false
      $grantAccessButton.Enabled = $false
      $closeAccessButton.Enabled = $false
      $output = Invoke-GoogleAccessGrant $email ([string]$selected.Kind) ([string]$selected.Value)
      $statusLabel.Text = "Đã cấp quyền Google."
      $statusLabel.ForeColor = $success
      Write-Log "CẤP QUYỀN: $output"
      [Windows.Forms.MessageBox]::Show($output, "Đã cấp quyền", "OK", "Information") | Out-Null
      $dialog.DialogResult = [Windows.Forms.DialogResult]::OK
      $dialog.Close()
    } catch {
      $statusLabel.Text = "Cấp quyền chưa hoàn tất."
      $statusLabel.ForeColor = $danger
      Write-Log "LỖI CẤP QUYỀN: $($_.Exception.Message)"
      [Windows.Forms.MessageBox]::Show($_.Exception.Message, "Không thể cấp quyền", "OK", "Error") | Out-Null
    } finally {
      if (-not $dialog.IsDisposed) {
        $dialog.UseWaitCursor = $false
        $accessEmailBox.Enabled = $true
        $accessScopeBox.Enabled = $true
        $grantAccessButton.Enabled = $true
        $closeAccessButton.Enabled = $true
      }
    }
  })

  $dialog.AcceptButton = $grantAccessButton
  $dialog.CancelButton = $closeAccessButton
  [void]$accessEmailBox.Focus()
  [void]$dialog.ShowDialog($form)
  $dialog.Dispose()
})
$deleteButton.Add_Click({
  if ($script:SyncRunning -or -not $script:EditingCourseId) { return }
  $courseId = $script:EditingCourseId
  $course = @($script:Catalog.courses) | Where-Object { [string]$_.id -ceq $courseId } | Select-Object -First 1
  if ($null -eq $course) {
    Refresh-CourseList
    Clear-Editor
    return
  }

  $confirmation = [Windows.Forms.MessageBox]::Show(
    "Xóa vĩnh viễn khóa '$([string]$course.title)'?`r`nMã: $courseId`r`n`r`n- Gỡ khóa khỏi catalog trên web.`r`n- Xóa đúng bài forum Discord do bot tạo.`r`n- Người học mất quyền mở khóa STREAM ngay khi catalog được lưu.`r`n`r`nKHÔNG xóa file HLS, lịch sử đơn hàng, quyền đã cấp hoặc quyền truy cập thư mục Drive.",
    "Xác nhận xóa khóa học",
    "YesNo",
    "Warning"
  )
  if ($confirmation -ne [Windows.Forms.DialogResult]::Yes) { return }

  $remoteDone = $false
  try {
    $current = Get-CatalogSnapshot
    $currentDelivery = Get-DeliverySnapshot
    if ($current.Fingerprint -ne $script:CatalogFingerprint -or $currentDelivery.Fingerprint -ne $script:DeliveryFingerprint) {
      Refresh-CourseList
      Clear-Editor
      [Windows.Forms.MessageBox]::Show("Catalog hoặc cấu hình Drive vừa được thay đổi ở nơi khác. Danh sách đã tải lại; chưa xóa nội dung nào.", "Dữ liệu đã thay đổi", "OK", "Warning") | Out-Null
      return
    }
    $preflightMatches = @($current.Catalog.courses | Where-Object { [string]$_.id -ceq $courseId })
    if ($preflightMatches.Count -eq 0) { throw "Không còn tìm thấy khóa học mã $courseId." }
    if ($preflightMatches.Count -ne 1) { throw "Catalog có nhiều khóa trùng mã $courseId; chưa xóa nội dung nào." }

    $form.UseWaitCursor = $true
    $syncButton.Enabled = $false
    $accessButton.Enabled = $false
    $listToolbar.Enabled = $false
    $courseGrid.Enabled = $false
    $editor.Enabled = $false
    $statusLabel.Text = "Đang xóa khóa học và bài Discord..."
    $statusLabel.ForeColor = $danger
    Write-Log "Đang xóa '$([string]$course.title)' ($courseId) khỏi Discord và catalog."

    $discordOutput = Invoke-DiscordCourseDelete $courseId
    $remoteDone = $true

    $afterDiscord = Get-CatalogSnapshot
    $afterDiscordDelivery = Get-DeliverySnapshot
    if ($afterDiscord.Fingerprint -ne $current.Fingerprint -or $afterDiscordDelivery.Fingerprint -ne $currentDelivery.Fingerprint) {
      throw "Bài Discord đã được xử lý nhưng catalog thay đổi ở nơi khác nên app không ghi đè. Hãy đồng bộ lại để tạo lại bài nếu cần."
    }

    $removedCourse = Remove-CourseData $afterDiscord.Catalog $afterDiscordDelivery.Delivery $courseId
    foreach ($catalogCourse in @($afterDiscord.Catalog.courses)) {
      if ($null -ne $catalogCourse.PSObject.Properties["driveFolderId"]) {
        $catalogCourse.PSObject.Properties.Remove("driveFolderId")
      }
    }
    Save-CatalogAtomically $afterDiscord.Catalog
    Save-CatalogAtomically $afterDiscordDelivery.Delivery $script:DeliveryPath

    Refresh-CourseList
    Clear-Editor
    if ($discordOutput) { Write-Log $discordOutput }
    $statusLabel.Text = "Đã xóa khóa học và bài Discord."
    $statusLabel.ForeColor = $success
    Write-Log "Đã xóa '$([string]$removedCourse.title)' ($courseId). HLS, đơn hàng và quyền đã cấp được giữ nguyên."
  } catch {
    try {
      Refresh-CourseList $courseId
      $refreshedCourse = @($script:Catalog.courses) | Where-Object { [string]$_.id -ceq $courseId } | Select-Object -First 1
      if ($null -eq $refreshedCourse) { Clear-Editor } else { Load-CourseIntoEditor $courseId }
    } catch {}
    $errorTitle = if ($remoteDone) { "Discord đã xử lý, catalog chưa xóa xong" } else { "Không thể xóa khóa học" }
    [Windows.Forms.MessageBox]::Show($_.Exception.Message, $errorTitle, "OK", "Error") | Out-Null
    $statusLabel.Text = "Xóa chưa hoàn tất."
    $statusLabel.ForeColor = $danger
    Write-Log "LỖI XÓA: $($_.Exception.Message)"
  } finally {
    $form.UseWaitCursor = $false
    $syncButton.Enabled = $true
    $accessButton.Enabled = $true
    $listToolbar.Enabled = $true
    $courseGrid.Enabled = $true
    $editor.Enabled = $true
    $deleteButton.Enabled = [bool]$script:EditingCourseId
  }
})
$courseGrid.Add_SelectionChanged({
  if ($courseGrid.SelectedRows.Count -eq 1) {
    Load-CourseIntoEditor ([string]$courseGrid.SelectedRows[0].Tag)
  }
})

$saveButton.Add_Click({
  try {
    $title = $titleBox.Text.Trim()
    $description = $descriptionBox.Text.Trim()
    $imageUrl = $imageUrlBox.Text.Trim()
    $previewUrl = $previewUrlBox.Text.Trim()
    $price = [decimal]$priceBox.Value
    $planTier = [string]$planBox.SelectedItem
    $deliveryMode = switch ($deliveryBox.SelectedIndex) { 1 { "DRIVE" } 2 { "STREAM" } default { "NON-STREAM" } }
    $driveFolderValue = $driveFolderBox.Text.Trim()
    $driveFolderId = if ($deliveryMode -eq "DRIVE") { Resolve-DriveFolderId $driveFolderValue } else { "" }
    $editingCourse = if ($script:EditingCourseId) {
      @($script:Catalog.courses) | Where-Object { [string]$_.id -eq $script:EditingCourseId } | Select-Object -First 1
    } else { $null }
    $hasPublishedLesson = $null -ne $editingCourse -and @($editingCourse.lessons | Where-Object { $_.published -eq $true }).Count -gt 0
    $errorMessage = Get-CourseValidationError $title $description $price $planTier $rightsBox.Checked $publishedBox.Checked $saleBox.Checked $deliveryMode $hasPublishedLesson $driveFolderValue $imageUrl $previewUrl
    if ($errorMessage) {
      [Windows.Forms.MessageBox]::Show($errorMessage, "Dữ liệu chưa hợp lệ", "OK", "Warning") | Out-Null
      return
    }

    $current = Get-CatalogSnapshot
    $currentDelivery = Get-DeliverySnapshot
    if ($current.Fingerprint -ne $script:CatalogFingerprint -or $currentDelivery.Fingerprint -ne $script:DeliveryFingerprint) {
      Refresh-CourseList
      Clear-Editor
      [Windows.Forms.MessageBox]::Show("Catalog hoặc cấu hình Drive vừa được thay đổi ở nơi khác. Danh sách đã tải lại; hãy nhập lại để tránh ghi đè dữ liệu.", "Dữ liệu đã thay đổi", "OK", "Warning") | Out-Null
      return
    }

    $workingCatalog = $current.Catalog
    $workingDelivery = $currentDelivery.Delivery
    $courses = @($workingCatalog.courses)
    if ($script:EditingCourseId) {
      $course = $courses | Where-Object { [string]$_.id -eq $script:EditingCourseId } | Select-Object -First 1
      if ($null -eq $course) { throw "Không còn tìm thấy khóa học mã $($script:EditingCourseId)." }
      $courseId = $script:EditingCourseId
    } else {
      $courseId = New-UniqueCourseId $title $courses
      $course = [pscustomobject][ordered]@{
        id = $courseId
        title = $title
        description = $description
        imageUrl = $imageUrl
        previewUrl = $previewUrl
        price = [long]$price
        planTier = $planTier
        deliveryMode = "NON-STREAM"
        streamAvailable = $false
        saleEnabled = $false
        published = $false
        forumVisible = $true
        rightsVerified = $false
        lessons = @()
      }
      $workingCatalog.courses = @($courses + $course)
    }

    Set-CourseProperty $course "title" $title
    Set-CourseProperty $course "description" $description
    Set-CourseProperty $course "imageUrl" $imageUrl
    Set-CourseProperty $course "previewUrl" $previewUrl
    Set-CourseProperty $course "price" ([long]$price)
    Set-CourseProperty $course "planTier" $planTier
    Set-CourseProperty $course "deliveryMode" $deliveryMode
    Set-CourseProperty $course "streamAvailable" ($deliveryMode -eq "STREAM")
    Set-CourseProperty $course "saleEnabled" ([bool]$saleBox.Checked)
    Set-CourseProperty $course "forumVisible" $true
    Set-CourseProperty $course "rightsVerified" ([bool]$rightsBox.Checked)
    Set-CourseProperty $course "published" ([bool]$publishedBox.Checked)

    Set-PrivateDriveFolder $workingDelivery $courseId $driveFolderId
    foreach ($catalogCourse in @($workingCatalog.courses)) {
      if ($null -ne $catalogCourse.PSObject.Properties["driveFolderId"]) {
        $catalogCourse.PSObject.Properties.Remove("driveFolderId")
      }
    }
    # Publish the mode first. If the private write then fails, a new DRIVE course stays fail-closed
    # and an existing DRIVE course keeps its previous folder instead of switching content early.
    Save-CatalogAtomically $workingCatalog
    Save-CatalogAtomically $workingDelivery $script:DeliveryPath
    Refresh-CourseList $courseId
    Load-CourseIntoEditor $courseId
    $statusLabel.Text = "Đã cập nhật web; đang đồng bộ Discord..."
    $statusLabel.ForeColor = $success
    Write-Log "Đã lưu '$title' ($courseId). Bắt đầu tự đồng bộ Discord."
    $script:AutoSyncRequested = $true
    [void]$syncButton.PerformClick()
  } catch {
    [Windows.Forms.MessageBox]::Show($_.Exception.Message, "Không thể lưu khóa học", "OK", "Error") | Out-Null
    Write-Log "LỖI LƯU: $($_.Exception.Message)"
  }
})

$syncTimer = New-Object Windows.Forms.Timer
$syncTimer.Interval = 250
$syncTimer.Add_Tick({
  if ($null -eq $script:SyncProcess -or -not $script:SyncProcess.HasExited) { return }
  $syncTimer.Stop()
  $stdout = $script:SyncStdoutTask.Result.Trim()
  $stderr = $script:SyncStderrTask.Result.Trim()
  $exitCode = $script:SyncProcess.ExitCode
  $script:SyncProcess.Dispose()
  $script:SyncProcess = $null
  $script:SyncStdoutTask = $null
  $script:SyncStderrTask = $null
  $script:SyncRunning = $false
  $syncButton.Enabled = $true
  $accessButton.Enabled = $true
  $listToolbar.Enabled = $true
  $courseGrid.Enabled = $true
  $editor.Enabled = $true
  $deleteButton.Enabled = [bool]$script:EditingCourseId
  if ($stdout) { Write-Log $stdout }
  if ($stderr) { Write-Log "LỖI: $stderr" }
  if ($exitCode -eq 0) {
    $statusLabel.Text = "Đã đồng bộ catalog lên Discord."
    $statusLabel.ForeColor = $success
    Write-Log "Đồng bộ Discord hoàn tất."
  } else {
    $statusLabel.Text = "Đã lưu, chưa đăng — đồng bộ thất bại."
    $statusLabel.ForeColor = $muted
    Write-Log "Đồng bộ thất bại (mã $exitCode). Catalog đã lưu, chưa đăng lên Discord."
  }
})

$syncButton.Add_Click({
  if ($script:SyncRunning) { return }
  $autoSync = $script:AutoSyncRequested
  $script:AutoSyncRequested = $false
  if (-not $autoSync) {
    $answer = [Windows.Forms.MessageBox]::Show(
      "Chỉ dữ liệu đã lưu trong catalog được dùng. Đăng/cập nhật tất cả khóa forumVisible lên kênh Discord ngay bây giờ?",
      "Xác nhận đồng bộ Discord",
      "YesNo",
      "Question"
    )
    if ($answer -ne [Windows.Forms.DialogResult]::Yes) { return }
  }

  try {
    $script:SyncRunning = $true
    $syncButton.Enabled = $false
    $accessButton.Enabled = $false
    $listToolbar.Enabled = $false
    $courseGrid.Enabled = $false
    $editor.Enabled = $false
    $statusLabel.Text = "Đang đồng bộ Discord..."
    $statusLabel.ForeColor = $muted
    Write-Log "Bắt đầu đồng bộ catalog lên Discord."

    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = (Get-Command node.exe -ErrorAction Stop).Source
    $startInfo.Arguments = '--env-file-if-exists=.env scripts/sync-discord-courses.js --publish'
    $startInfo.WorkingDirectory = $script:RepoRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.StandardOutputEncoding = [Text.Encoding]::UTF8
    $startInfo.StandardErrorEncoding = [Text.Encoding]::UTF8

    $script:SyncProcess = New-Object Diagnostics.Process
    $script:SyncProcess.StartInfo = $startInfo
    if (-not $script:SyncProcess.Start()) { throw "Không thể khởi chạy tiến trình đồng bộ." }
    $script:SyncStdoutTask = $script:SyncProcess.StandardOutput.ReadToEndAsync()
    $script:SyncStderrTask = $script:SyncProcess.StandardError.ReadToEndAsync()
    $syncTimer.Start()
  } catch {
    if ($null -ne $script:SyncProcess) { $script:SyncProcess.Dispose(); $script:SyncProcess = $null }
    $script:SyncStdoutTask = $null
    $script:SyncStderrTask = $null
    $script:SyncRunning = $false
    $syncButton.Enabled = $true
    $accessButton.Enabled = $true
    $listToolbar.Enabled = $true
    $courseGrid.Enabled = $true
    $editor.Enabled = $true
    $deleteButton.Enabled = [bool]$script:EditingCourseId
    $statusLabel.Text = "Đã lưu, chưa đăng — không chạy được đồng bộ."
    $statusLabel.ForeColor = $muted
    Write-Log "LỖI ĐỒNG BỘ: $($_.Exception.Message). Catalog đã lưu, chưa đăng lên Discord."
  }
})

$form.Add_FormClosing({
  param($sender, $eventArgs)
  if ($script:SyncRunning) {
    $eventArgs.Cancel = $true
    [Windows.Forms.MessageBox]::Show("Đang đồng bộ Discord. Hãy chờ tiến trình hoàn tất.", "Nixart", "OK", "Information") | Out-Null
  }
})

try {
  Refresh-CourseList
  Clear-Editor
  Write-Log "Đã tải $(@($script:Catalog.courses).Count) khóa học."
  if ($LayoutTest) {
    $form.Show()
    [Windows.Forms.Application]::DoEvents()
    if ($form.ClientSize.Width -ne 1280 -or $form.ClientSize.Height -ne 820) { throw "Kích thước mặc định phải là 1280x820." }
    if ($split.Top -lt $header.Bottom -or $split.Bottom -gt $outputGroup.Top) { throw "Khu vực nội dung chồng lên header hoặc nhật ký." }
    if ($outputGroup.Height -ne 150 -or $outputBox.Top -lt 31) { throw "Khung nhật ký không đúng chiều cao hoặc chồng tiêu đề." }
    if ($split.Panel2.ClientSize.Width -lt 500) { throw "Khung nhập khóa học quá hẹp: $($split.Panel2.ClientSize.Width)px." }
    $priceLabel = $editorBody.Controls | Where-Object { $_ -is [Windows.Forms.Label] -and $_.Text -eq "GIÁ BÁN (VNĐ)" } | Select-Object -First 1
    $planLabel = $editorBody.Controls | Where-Object { $_ -is [Windows.Forms.Label] -and $_.Text -eq "THUỘC GÓI" } | Select-Object -First 1
    if ($priceLabel.Bounds.IntersectsWith($planLabel.Bounds)) { throw "Nhãn Giá bán và Thuộc gói đang chồng nhau." }
    if ($deliveryBox.Items.Count -ne 3) { throw "Danh sách hình thức học phải có NON-STREAM, DRIVE và STREAM." }
    if ($driveFolderBox.Top -lt $deliveryBox.Bottom) { throw "Ô thư mục Drive đang chồng lên danh sách hình thức học." }
    if ($courseGrid.RowTemplate.Height -ne 40) { throw "Hàng catalog phải cao 40px." }
    if ($saveButton.Bottom -gt $editorHeader.ClientSize.Height -or $cancelButton.Bottom -gt $editorHeader.ClientSize.Height) { throw "Nút lưu hoặc hủy nằm ngoài header trình sửa." }
    if ($deleteButton.Parent -ne $listToolbar -or $newButton.Bounds.IntersectsWith($deleteButton.Bounds)) { throw "Nút tạo mới và xóa bài đăng sai vị trí hoặc đang chồng nhau." }
    if ($deleteButton.Enabled) { throw "Nút xóa phải tắt khi chưa chọn khóa học." }
    if ($accessButton.Parent -ne $header -or $statusLabel.Bounds.IntersectsWith($accessButton.Bounds) -or $accessButton.Bounds.IntersectsWith($syncButton.Bounds)) { throw "Nút cấp quyền email sai vị trí hoặc đang chồng nhau." }
    if ($statusLabel.Bottom -gt $header.ClientSize.Height -or $accessButton.Bottom -gt $header.ClientSize.Height -or $syncButton.Bottom -gt $header.ClientSize.Height) { throw "Điều khiển header nằm ngoài khung." }
    $accessOptions = @(Get-GoogleAccessOptions)
    if ($accessOptions.Count -eq 0 -or $accessOptions[0].Kind -ne "plan" -or $accessOptions[0].Value -ne "full") { throw "Cấp quyền phải mặc định gói Full." }
    Write-Host ("LAYOUT-TEST OK form={0}x{1} content={2} editor={3}px log={4}" -f $form.ClientSize.Width, $form.ClientSize.Height, $split.Bounds, $split.Panel2.ClientSize.Width, $outputGroup.Bounds)
    $form.Close()
  } else {
    [Windows.Forms.Application]::Run($form)
  }
} catch {
  [Windows.Forms.MessageBox]::Show($_.Exception.Message, "Nixart Course Manager", "OK", "Error") | Out-Null
} finally {
  if ($createdNew) { $mutex.ReleaseMutex() | Out-Null }
  $mutex.Dispose()
}

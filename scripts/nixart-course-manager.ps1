[CmdletBinding()]
param(
  [switch]$SelfTest,
  [switch]$LayoutTest
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName Microsoft.VisualBasic

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
$script:ImportProcess = $null
$script:ImportStdoutTask = $null
$script:ImportStderrTask = $null
$script:ImportCourseId = ""
$script:RvpProcess = $null
$script:RvpStdoutTask = $null
$script:RvpStderrTask = $null
$script:RvpCourseId = ""

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
  if (@("DRIVE", "STREAM", "RVP_DEVICE", "NON-STREAM") -contains $mode) { return $mode }
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
    [string]$PreviewUrl,
    [bool]$FreeAccess = $false,
    [bool]$HasRvpPackage = $false
  )

  if ([string]::IsNullOrWhiteSpace($Title)) { return "Hãy nhập tên khóa học." }
  if ($Title.Length -gt 100) { return "Tên khóa học tối đa 100 ký tự." }
  if ([regex]::IsMatch($Title, "[\p{Cc}\u202A-\u202E\u2066-\u2069]")) { return "Tên khóa học không được chứa ký tự điều khiển hoặc đổi hướng chữ." }
  if ($Description.Length -gt 4000) { return "Mô tả tối đa 4.000 ký tự." }
  if ([regex]::IsMatch($Description, "[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\u202A-\u202E\u2066-\u2069]")) { return "Mô tả chứa ký tự điều khiển hoặc đổi hướng chữ không hợp lệ." }
  if ($Price -lt 0 -or $Price -ne [decimal]::Truncate($Price)) { return "Giá phải là số nguyên không âm." }
  if (@("basic", "full") -notcontains $PlanTier) { return "Gói phải là basic hoặc full." }
  if (@("NON-STREAM", "DRIVE", "STREAM", "RVP_DEVICE") -notcontains $DeliveryMode) { return "Hình thức giao nội dung không hợp lệ." }
  if ($Published -and -not $RightsVerified) { return "Muốn công khai trên web, bạn phải xác nhận quyền phân phối khóa học." }
  if ($SaleEnabled -and -not $Published) { return "Muốn mở thanh toán, khóa học phải được công khai trên web." }
  if ($SaleEnabled -and -not $RightsVerified) { return "Muốn mở thanh toán, bạn phải xác nhận quyền phân phối khóa học." }
  if ($SaleEnabled -and $Price -le 0) { return "Muốn mở thanh toán, giá khóa học phải lớn hơn 0." }
  if ($SaleEnabled -and $DeliveryMode -eq "NON-STREAM") { return "Khóa NON-STREAM chưa có cách giao nội dung nên không thể mở thanh toán." }
  if ($SaleEnabled -and $DeliveryMode -eq "STREAM" -and -not $HasPublishedLesson) { return "Muốn mở thanh toán STREAM, khóa học phải có ít nhất một bài HLS đã published." }
  if ($SaleEnabled -and $DeliveryMode -eq "RVP_DEVICE" -and -not $HasRvpPackage) { return "Muốn mở thanh toán RVP, hãy dùng nút ĐÓNG GÓI RVP trước." }
  if ($FreeAccess -and $SaleEnabled) { return "Khóa học miễn phí không thể đồng thời mở thanh toán." }
  if ($FreeAccess -and -not $Published) { return "Muốn chia sẻ miễn phí, khóa học phải được công khai trên web." }
  if ($FreeAccess -and -not $RightsVerified) { return "Muốn chia sẻ miễn phí, bạn phải xác nhận quyền phân phối khóa học." }
  if ($FreeAccess -and $DeliveryMode -ne "STREAM") { return "Chia sẻ miễn phí hiện chỉ áp dụng cho khóa STREAM." }
  if ($FreeAccess -and -not $HasPublishedLesson) { return "Khóa miễn phí phải có ít nhất một bài HLS đã published." }
  if ($DeliveryMode -eq "DRIVE" -and -not (Resolve-DriveFolderId $DriveFolderValue)) { return "Khóa DRIVE cần folder ID hoặc URL thư mục drive.google.com hợp lệ." }
  if ($DeliveryMode -eq "RVP_DEVICE" -and $DriveFolderValue -and -not (Resolve-DriveFolderId $DriveFolderValue)) { return "Link Drive của RVP phải là folder ID hoặc URL thư mục drive.google.com hợp lệ." }
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
  if (Normalize-GoogleAccessEmail 'user@gmail.com" --course course-a') { throw "Không chặn ký tự dòng lệnh trong email" }
  $folderId = "1AbCdEfGhIjKlMnOpQrStUvWxYz"
  if ((Resolve-DriveFolderId "https://drive.google.com/drive/u/0/folders/${folderId}?usp=sharing") -ne $folderId) { throw "Chuẩn hóa URL Drive thất bại" }
  if ((Resolve-DriveFolderId $folderId) -ne $folderId -or (Resolve-DriveFolderId "https://example.com/drive/folders/$folderId")) { throw "Kiểm tra folder Drive thất bại" }
  if ((Get-CourseDeliveryMode ([pscustomobject]@{ streamAvailable = $true })) -ne "STREAM") { throw "Tương thích streamAvailable thất bại" }
  if ((Get-CourseDeliveryMode ([pscustomobject]@{ deliveryMode = "DRIVE"; streamAvailable = $false })) -ne "DRIVE") { throw "deliveryMode không được ưu tiên" }
  if ((Get-CourseDeliveryMode ([pscustomobject]@{ deliveryMode = "RVP_DEVICE"; rvpAvailable = $true })) -ne "RVP_DEVICE") { throw "RVP_DEVICE không được nhận diện" }
  if (-not (Get-CourseValidationError "A" "" 100 "full" $false $true $false "NON-STREAM" $false "" "" "")) { throw "Kiểm tra quyền công khai thất bại" }
  if (-not (Get-CourseValidationError "A" "" 100 "full" $true $true $true "NON-STREAM" $false "" "" "")) { throw "Kiểm tra thanh toán NON-STREAM thất bại" }
  if (Get-CourseValidationError "A" "" 100 "full" $true $true $false "STREAM" $false "" "" "") { throw "Draft STREAM không thể lưu" }
  if (-not (Get-CourseValidationError "A" "" 100 "full" $true $true $true "STREAM" $false "" "" "")) { throw "Kiểm tra bài HLS STREAM thanh toán thất bại" }
  if (-not (Get-CourseValidationError "A" "" 100 "full" $true $true $false "DRIVE" $false "invalid" "" "")) { throw "Kiểm tra thư mục DRIVE thất bại" }
  if (Get-CourseValidationError "A" "" 100 "full" $true $true $true "DRIVE" $false $folderId "" "") { throw "Khóa DRIVE hợp lệ không thể mở bán" }
  if (Get-CourseValidationError "A" "" 100 "full" $true $true $true "STREAM" $true "" "" "") { throw "Khóa STREAM hợp lệ không thể mở bán" }
  if (-not (Get-CourseValidationError "A" "" 100 "full" $true $true $true "RVP_DEVICE" $false "" "" "" $false $false)) { throw "Không chặn RVP chưa đóng gói" }
  if (Get-CourseValidationError "A" "" 100 "full" $true $true $true "RVP_DEVICE" $false "" "" "" $false $true) { throw "RVP đã đóng gói không thể mở bán" }
  if (Get-CourseValidationError "A" "" 100 "full" $true $true $false "STREAM" $true "" "" "" $true) { throw "Khóa STREAM miễn phí hợp lệ không thể lưu" }
  if (-not (Get-CourseValidationError "A" "" 100 "full" $true $true $true "STREAM" $true "" "" "" $true)) { throw "Không chặn khóa vừa miễn phí vừa mở bán" }
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
if ($LayoutTest) { $mutexName += '-layout-test' }
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
$statusLabel.Location = New-Object Drawing.Point(515, 20)
$statusLabel.Size = New-Object Drawing.Size(190, 36)
$statusLabel.Anchor = "Top, Right"
$statusLabel.BackColor = $surface2
$statusLabel.ForeColor = $muted
$statusLabel.BorderStyle = "FixedSingle"
$statusLabel.TextAlign = "MiddleCenter"
$statusLabel.AutoEllipsis = $true
$statusLabel.Font = New-Object Drawing.Font("Segoe UI Semibold", 8.5)
$header.Controls.Add($statusLabel)

$groupBuyButton = New-Object Windows.Forms.Button
$groupBuyButton.Text = "GROUPBUY"
$groupBuyButton.Size = New-Object Drawing.Size(140, 38)
$groupBuyButton.Location = New-Object Drawing.Point(719, 19)
$groupBuyButton.Anchor = "Top, Right"
$groupBuyButton.FlatStyle = "Flat"
$groupBuyButton.BackColor = $surface2
$groupBuyButton.ForeColor = $discord
$groupBuyButton.Font = New-Object Drawing.Font("Segoe UI Semibold", 8.5)
$groupBuyButton.FlatAppearance.BorderColor = $discord
$groupBuyButton.FlatAppearance.MouseOverBackColor = [Drawing.Color]::FromArgb(31, 34, 60)
$header.Controls.Add($groupBuyButton)

$accessButton = New-Object Windows.Forms.Button
$accessButton.Text = "QUẢN LÝ EMAIL"
$accessButton.Size = New-Object Drawing.Size(160, 38)
$accessButton.Location = New-Object Drawing.Point(873, 19)
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
$syncButton.Size = New-Object Drawing.Size(211, 38)
$syncButton.Location = New-Object Drawing.Point(1047, 19)
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
$newButton.Size = New-Object Drawing.Size(105, 34)
$newButton.Location = New-Object Drawing.Point(325, 12)
$newButton.Anchor = "Top, Right"
$newButton.FlatStyle = "Flat"
$newButton.BackColor = $discord
$newButton.ForeColor = $text
$newButton.Font = New-Object Drawing.Font("Segoe UI Semibold", 8.5)
$newButton.FlatAppearance.BorderColor = $discord
$listToolbar.Controls.Add($newButton)

$importButton = New-Object Windows.Forms.Button
$importButton.Text = "NHẬP STREAM"
$importButton.Size = New-Object Drawing.Size(105, 34)
$importButton.Location = New-Object Drawing.Point(110, 12)
$importButton.Anchor = "Top, Right"
$importButton.FlatStyle = "Flat"
$importButton.BackColor = $surface2
$importButton.ForeColor = $success
$importButton.Font = New-Object Drawing.Font("Segoe UI Semibold", 8.5)
$importButton.FlatAppearance.BorderColor = $success
$listToolbar.Controls.Add($importButton)

$rvpButton = New-Object Windows.Forms.Button
$rvpButton.Text = "ĐÓNG GÓI RVP"
$rvpButton.Size = New-Object Drawing.Size(100, 34)
$rvpButton.Location = New-Object Drawing.Point(220, 12)
$rvpButton.Anchor = "Top, Right"
$rvpButton.FlatStyle = "Flat"
$rvpButton.BackColor = $surface2
$rvpButton.ForeColor = $accent
$rvpButton.Font = New-Object Drawing.Font("Segoe UI Semibold", 8.3)
$rvpButton.FlatAppearance.BorderColor = $accent
$listToolbar.Controls.Add($rvpButton)

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
  "STREAM — học trực tiếp trên web",
  "RVP DEVICE — tải một file, khóa theo thiết bị"
))
$deliveryBox.SelectedIndex = 0
$editorBody.Controls.Add($deliveryBox)

Add-EditorLabel "GOOGLE DRIVE FOLDER ID HOẶC URL THƯ MỤC" 359
$driveFolderBox = New-EditorTextBox 376 30
$driveFolderBox.MaxLength = 2000
$driveFolderBox.Enabled = $false
$deliveryBox.Add_SelectedIndexChanged({
  # DRIVE and RVP both use one shared Drive folder/link input.
  $driveFolderBox.Enabled = $deliveryBox.SelectedIndex -in @(1, 3)
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
$saleBox.Text = "Mở thanh toán (DRIVE / STREAM / RVP đã cấu hình)"
$saleBox.AutoSize = $true
$saleBox.Location = New-Object Drawing.Point(18, 468)
$saleBox.FlatStyle = "Flat"
$editorBody.Controls.Add($saleBox)

$freeBox = New-Object Windows.Forms.CheckBox
$freeBox.Text = "Chia sẻ khóa học miễn phí (không yêu cầu thanh toán)"
$freeBox.AutoSize = $true
$freeBox.Location = New-Object Drawing.Point(18, 492)
$freeBox.FlatStyle = "Flat"
$editorBody.Controls.Add($freeBox)
$freeBox.Add_CheckedChanged({
  if ($freeBox.Checked) { $saleBox.Checked = $false }
  $saleBox.Enabled = -not $freeBox.Checked
})
$saleBox.Add_CheckedChanged({
  if ($saleBox.Checked) { $freeBox.Checked = $false }
})

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
  foreach ($course in @($script:Catalog.courses)) {
    $courseId = [string]$course.id
    $hasPublishedLesson = @($course.lessons | Where-Object { $_.published -eq $true }).Count -gt 0
    if ($courseId -cmatch '^[a-z0-9][a-z0-9_-]{0,79}$' -and
        $course.published -eq $true -and $course.rightsVerified -eq $true -and
        (Get-CourseDeliveryMode $course) -eq "STREAM" -and $hasPublishedLesson) {
      $options += [pscustomobject]@{
        Label = "Khóa · $([string]$course.title) · $courseId"
        Value = $courseId
      }
    }
  }
  @($options)
}

function Invoke-GoogleAccessGrant {
  param([string]$Email, [string]$CourseId)

  $email = Normalize-GoogleAccessEmail $Email
  if (-not $email) { throw "Hãy nhập đúng một email Google hợp lệ." }
  if ($CourseId -cnotmatch '^[a-z0-9][a-z0-9_-]{0,79}$') { throw "Mã khóa học không hợp lệ." }

  $startInfo = New-Object Diagnostics.ProcessStartInfo
  $startInfo.FileName = (Get-Command node.exe -ErrorAction Stop).Source
  $startInfo.Arguments = '--env-file-if-exists=.env scripts/grant-google-access.js --email "{0}" --course {1}' -f $email, $CourseId
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

function Invoke-GoogleAccessManagerCommand {
  param([string]$Arguments)

  $startInfo = New-Object Diagnostics.ProcessStartInfo
  $startInfo.FileName = (Get-Command node.exe -ErrorAction Stop).Source
  $startInfo.Arguments = "--env-file-if-exists=.env scripts/manage-google-access.js $Arguments"
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
    if (-not $process.Start()) { throw "Không thể khởi chạy trình quản lý quyền email." }
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
    throw "Không thể quản lý quyền email (mã $exitCode)."
  }
  $stdout
}

function Get-GoogleAccessGrants {
  $json = Invoke-GoogleAccessManagerCommand "--list"
  if (-not $json) { return @() }
  $parsed = $json | ConvertFrom-Json
  @($parsed | ForEach-Object { $_ })
}

function Revoke-GoogleAccessGrant {
  param([string]$GrantId)
  if ($GrantId -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') {
    throw "Mã quyền truy cập không hợp lệ."
  }
  Invoke-GoogleAccessManagerCommand ("--revoke {0}" -f $GrantId)
}

function Invoke-GroupBuyManagerCommand {
  param([string]$Arguments)

  $startInfo = New-Object Diagnostics.ProcessStartInfo
  $startInfo.FileName = (Get-Command node.exe -ErrorAction Stop).Source
  $startInfo.Arguments = "--env-file-if-exists=.env scripts/manage-groupbuys.js $Arguments"
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
    if (-not $process.Start()) { throw "Không thể khởi chạy trình quản lý GroupBuy." }
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
    throw "Không thể quản lý GroupBuy (mã $exitCode)."
  }
  $stdout
}

function Get-GroupBuyCampaigns {
  $json = Invoke-GroupBuyManagerCommand "--list"
  if (-not $json) { return @() }
  @($json | ConvertFrom-Json | ForEach-Object { $_ })
}

function New-GroupBuyCampaign {
  param($Data)
  $json = $Data | ConvertTo-Json -Depth 5 -Compress
  $base64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
  (Invoke-GroupBuyManagerCommand ("--create-base64 {0}" -f $base64)) | ConvertFrom-Json
}

function Quote-StreamImportArgument {
  param([string]$Value)
  if ($Value -match '["\x00-\x1F]') { throw "Giá trị nhập STREAM chứa ký tự không được hỗ trợ." }
  '"' + $Value + '"'
}

function New-StreamImportStartInfo {
  param(
    [string]$Folder,
    [string]$CourseId,
    [string]$Title,
    [bool]$PreferVietnamese,
    [bool]$ReuseExistingHls,
    [bool]$Plan
  )

  if (-not [IO.Directory]::Exists($Folder)) { throw "Không tìm thấy thư mục khóa học." }
  if ($CourseId -cnotmatch '^[a-z0-9][a-z0-9_-]{0,79}$') { throw "Mã khóa học không hợp lệ." }
  if (-not $Title.Trim() -or $Title.Length -gt 100) { throw "Tên khóa học cần từ 1 đến 100 ký tự." }
  $scriptPath = Join-Path $script:RepoRoot 'scripts\package-hls-folder.ps1'
  $storageRoot = Join-Path ([IO.Path]::GetFullPath($Folder)) '.nixart-stream'
  $arguments = @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Quote-StreamImportArgument $scriptPath),
    '-InputFolder', (Quote-StreamImportArgument ([IO.Path]::GetFullPath($Folder))),
    '-CourseId', $CourseId,
    '-CourseTitle', (Quote-StreamImportArgument $Title.Trim()),
    '-StorageRoot', (Quote-StreamImportArgument $storageRoot),
    '-Recurse'
  )
  if ($PreferVietnamese) { $arguments += '-PreferVietnamese' }
  if ($ReuseExistingHls) { $arguments += '-ReuseExistingHls' }
  if ($Plan) { $arguments += @('-Plan', '-JsonPlan') }

  $startInfo = New-Object Diagnostics.ProcessStartInfo
  $startInfo.FileName = (Get-Command powershell.exe -ErrorAction Stop).Source
  $startInfo.Arguments = $arguments -join ' '
  $startInfo.WorkingDirectory = $script:RepoRoot
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.StandardOutputEncoding = [Text.Encoding]::UTF8
  $startInfo.StandardErrorEncoding = [Text.Encoding]::UTF8
  $startInfo
}

function Get-LocalConfigValue {
  param([string]$Name)
  $value = [Environment]::GetEnvironmentVariable($Name)
  if ($value) { return $value }
  $envPath = Join-Path $script:RepoRoot ".env"
  if (-not [IO.File]::Exists($envPath)) { return "" }
  foreach ($line in [IO.File]::ReadAllLines($envPath)) {
    if ($line -match ('^\s*{0}\s*=\s*(.*)\s*$' -f [regex]::Escape($Name))) {
      return $matches[1].Trim().Trim('"').Trim("'")
    }
  }
  ""
}

function New-RvpPackStartInfo {
  param([string]$Folder, [string]$CourseId, [string]$Title, [string]$OutputPath, [string]$DriveFolder)
  $token = Get-LocalConfigValue "RVP_ADMIN_TOKEN"
  if ($token.Length -lt 32) { $token = Get-LocalConfigValue "ADMIN_PASSWORD" }
  if ($token.Length -lt 32) { throw "Thiếu RVP_ADMIN_TOKEN hoặc ADMIN_PASSWORD trong biến môi trường/file .env." }
  $apiBase = Get-LocalConfigValue "RVP_API_BASE"
  if (-not $apiBase) { $apiBase = "https://nixart-web.onrender.com" }
  $scriptPath = Join-Path $script:RepoRoot "scripts\pack-rvp-course.ps1"
  $arguments = @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Quote-StreamImportArgument $scriptPath),
    '-SourceFolder', (Quote-StreamImportArgument ([IO.Path]::GetFullPath($Folder))),
    '-CourseId', $CourseId, '-Title', (Quote-StreamImportArgument $Title),
    '-OutputPath', (Quote-StreamImportArgument ([IO.Path]::GetFullPath($OutputPath))),
    '-DriveFolder', (Quote-StreamImportArgument $DriveFolder),
    '-ApiBase', (Quote-StreamImportArgument $apiBase)
  )
  $startInfo = New-Object Diagnostics.ProcessStartInfo
  $startInfo.FileName = (Get-Command powershell.exe -ErrorAction Stop).Source
  $startInfo.Arguments = $arguments -join ' '
  $startInfo.WorkingDirectory = $script:RepoRoot
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.StandardOutputEncoding = [Text.Encoding]::UTF8
  $startInfo.StandardErrorEncoding = [Text.Encoding]::UTF8
  $startInfo.EnvironmentVariables["RVP_ADMIN_TOKEN"] = $token
  $startInfo
}

function Get-StreamFolderPlan {
  param([string]$Folder, [string]$CourseId, [string]$Title, [bool]$PreferVietnamese, [bool]$ReuseExistingHls)

  $process = New-Object Diagnostics.Process
  try {
    $process.StartInfo = New-StreamImportStartInfo $Folder $CourseId $Title $PreferVietnamese $ReuseExistingHls $true
    if (-not $process.Start()) { throw "Không thể khởi chạy bộ quét STREAM." }
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
    throw "Bộ quét STREAM thất bại (mã $exitCode)."
  }
  if (-not $stdout) { throw "Bộ quét STREAM không trả về dữ liệu." }
  $stdout | ConvertFrom-Json
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
  $freeBox.Checked = $false
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
    $price = if ($course.freeAccess -eq $true) { "Miễn phí" } elseif ([decimal]$course.price -gt 0) { "{0:N0}đ" -f [decimal]$course.price } else { "—" }
    $hasPublishedLesson = @($course.lessons | Where-Object { $_.published -eq $true }).Count -gt 0
    $deliveryMode = Get-CourseDeliveryMode $course
    $deliveryReady = switch ($deliveryMode) {
      "DRIVE" { [bool](Resolve-DriveFolderId (Get-PrivateDriveFolder ([string]$course.id))) }
      "STREAM" { $hasPublishedLesson }
      "RVP_DEVICE" { $course.rvpAvailable -eq $true }
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
      $(if ($course.freeAccess -eq $true) { "Miễn phí" } elseif ($saleReady) { "Có" } else { "Chưa" })
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
  $deliveryBox.SelectedIndex = switch ($deliveryMode) { "DRIVE" { 1 } "STREAM" { 2 } "RVP_DEVICE" { 3 } default { 0 } }
  $driveFolderBox.Text = Get-PrivateDriveFolder ([string]$course.id)
  $rightsBox.Checked = $course.rightsVerified -eq $true
  $publishedBox.Checked = $course.published -eq $true
  $saleBox.Checked = $course.saleEnabled -eq $true
  $freeBox.Checked = $course.freeAccess -eq $true
  $idLabel.Text = "MÃ KHÓA HỌC  ·  $($script:EditingCourseId)"
  $saveButton.Text = "LƯU THAY ĐỔI"
  $deleteButton.Enabled = $true
}

$rvpTimer = New-Object Windows.Forms.Timer
$rvpTimer.Interval = 500
$rvpTimer.Add_Tick({
  if ($null -eq $script:RvpProcess -or -not $script:RvpProcess.HasExited) { return }
  $rvpTimer.Stop()
  $stdout = $script:RvpStdoutTask.Result.Trim()
  $stderr = $script:RvpStderrTask.Result.Trim()
  $exitCode = $script:RvpProcess.ExitCode
  $courseId = $script:RvpCourseId
  $script:RvpProcess.Dispose()
  $script:RvpProcess = $null
  $script:RvpStdoutTask = $null
  $script:RvpStderrTask = $null
  $script:RvpCourseId = ""
  $script:SyncRunning = $false
  $listToolbar.Enabled = $true
  $courseGrid.Enabled = $true
  $editor.Enabled = $true
  if ($stdout) { Write-Log $stdout }
  if ($stderr) { Write-Log "LỖI RVP: $stderr" }
  if ($exitCode -eq 0) {
    Refresh-CourseList $courseId
    Load-CourseIntoEditor $courseId
    $statusLabel.Text = "RVP đã đóng gói và đăng ký server."
    $statusLabel.ForeColor = $success
  } else {
    $statusLabel.Text = "Đóng gói RVP thất bại."
    $statusLabel.ForeColor = $danger
  }
})

$importTimer = New-Object Windows.Forms.Timer
$importTimer.Interval = 500
$importTimer.Add_Tick({
  if ($null -eq $script:ImportProcess -or -not $script:ImportProcess.HasExited) { return }
  $importTimer.Stop()
  $stdout = $script:ImportStdoutTask.Result.Trim()
  $stderr = $script:ImportStderrTask.Result.Trim()
  $exitCode = $script:ImportProcess.ExitCode
  $courseId = $script:ImportCourseId
  $script:ImportProcess.Dispose()
  $script:ImportProcess = $null
  $script:ImportStdoutTask = $null
  $script:ImportStderrTask = $null
  $script:ImportCourseId = ""
  $script:SyncRunning = $false
  $syncButton.Enabled = $true
  $groupBuyButton.Enabled = $true
  $accessButton.Enabled = $true
  $listToolbar.Enabled = $true
  $courseGrid.Enabled = $true
  $editor.Enabled = $true
  if ($stdout) { Write-Log $stdout }
  if ($stderr) { Write-Log "LỖI: $stderr" }
  if ($exitCode -eq 0) {
    Refresh-CourseList $courseId
    Load-CourseIntoEditor $courseId
    $statusLabel.Text = "Đã nhập khóa STREAM; hãy hoàn thiện thông tin."
    $statusLabel.ForeColor = $success
    Write-Log "Nhập STREAM hoàn tất: $courseId."
  } else {
    $statusLabel.Text = "Nhập STREAM chưa hoàn tất."
    $statusLabel.ForeColor = $danger
    Write-Log "Nhập STREAM thất bại (mã $exitCode); có thể chạy lại để tiếp tục."
  }
})

$newButton.Add_Click({ Clear-Editor })
$cancelButton.Add_Click({ Clear-Editor })
$rvpButton.Add_Click({
  if ($script:SyncRunning) { return }
  if ($courseGrid.SelectedRows.Count -ne 1) {
    [Windows.Forms.MessageBox]::Show("Hãy tạo/lưu rồi chọn khóa học cần đóng gói.", "Đóng gói RVP", "OK", "Information") | Out-Null
    return
  }
  $courseId = [string]$courseGrid.SelectedRows[0].Tag
  $course = @($script:Catalog.courses) | Where-Object { [string]$_.id -ceq $courseId } | Select-Object -First 1
  if ($null -eq $course) { return }
  $folderPicker = New-Object Windows.Forms.FolderBrowserDialog
  $folderPicker.Description = "Chọn folder chứa video và subtitle của khóa học"
  $folderPicker.ShowNewFolderButton = $false
  if ($folderPicker.ShowDialog($form) -ne [Windows.Forms.DialogResult]::OK) { $folderPicker.Dispose(); return }
  $sourceFolder = $folderPicker.SelectedPath
  $folderPicker.Dispose()
  $saveDialog = New-Object Windows.Forms.SaveFileDialog
  $saveDialog.Title = "Lưu file RVP dùng chung để upload lên Drive"
  $saveDialog.Filter = "Nixart course package (*.rvp)|*.rvp"
  $saveDialog.FileName = "$courseId.rvp"
  if ($saveDialog.ShowDialog($form) -ne [Windows.Forms.DialogResult]::OK) { $saveDialog.Dispose(); return }
  $outputPath = $saveDialog.FileName
  $saveDialog.Dispose()
  $driveFolder = $driveFolderBox.Text.Trim()
  if (-not $driveFolder) {
    $driveFolder = [Microsoft.VisualBasic.Interaction]::InputBox(
      "Dán link hoặc ID folder Google Drive. Manager sẽ tự upload file .rvp vào folder này và lấy link chia sẻ.",
      "Folder Drive chứa RVP", "https://drive.google.com/drive/folders/...").Trim()
  }
  if (-not $driveFolder) { return }
  try {
    $startInfo = New-RvpPackStartInfo $sourceFolder $courseId ([string]$course.title) $outputPath $driveFolder
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $startInfo
    if (-not $process.Start()) { throw "Không thể khởi chạy bộ đóng gói RVP." }
    $script:RvpProcess = $process
    $script:RvpStdoutTask = $process.StandardOutput.ReadToEndAsync()
    $script:RvpStderrTask = $process.StandardError.ReadToEndAsync()
    $script:RvpCourseId = $courseId
    $script:SyncRunning = $true
    $listToolbar.Enabled = $false
    $courseGrid.Enabled = $false
    $editor.Enabled = $false
    $statusLabel.Text = "Đang mã hóa folder thành RVP..."
    $statusLabel.ForeColor = $accent
    Write-Log "Bắt đầu đóng gói RVP '$([string]$course.title)' ($courseId) -> $outputPath"
    $rvpTimer.Start()
  } catch {
    [Windows.Forms.MessageBox]::Show($_.Exception.Message, "Không thể đóng gói RVP", "OK", "Error") | Out-Null
    Write-Log "LỖI RVP: $($_.Exception.Message)"
  }
})
$importButton.Add_Click({
  if ($script:SyncRunning) { return }

  $dialog = New-Object Windows.Forms.Form
  $dialog.Text = "Nhập khóa STREAM từ thư mục"
  $dialog.StartPosition = "CenterParent"
  $dialog.FormBorderStyle = "FixedDialog"
  $dialog.MaximizeBox = $false
  $dialog.MinimizeBox = $false
  $dialog.ShowInTaskbar = $false
  $dialog.ClientSize = New-Object Drawing.Size(900, 650)
  $dialog.BackColor = $bg
  $dialog.ForeColor = $text
  $dialog.Font = New-Object Drawing.Font("Segoe UI", 10)

  $importTitle = New-Object Windows.Forms.Label
  $importTitle.Text = "NHẬP KHÓA STREAM"
  $importTitle.Font = New-Object Drawing.Font("Segoe UI Semibold", 14)
  $importTitle.AutoSize = $true
  $importTitle.Location = New-Object Drawing.Point(22, 18)
  $dialog.Controls.Add($importTitle)

  $importCopy = New-Object Windows.Forms.Label
  $importCopy.Text = "Quét mọi thư mục con, ghép video gốc/lồng tiếng và giữ file HLS trên ổ chứa khóa học."
  $importCopy.ForeColor = $muted
  $importCopy.AutoSize = $true
  $importCopy.Location = New-Object Drawing.Point(23, 49)
  $dialog.Controls.Add($importCopy)

  $folderLabel = New-Object Windows.Forms.Label
  $folderLabel.Text = "THƯ MỤC KHÓA HỌC"
  $folderLabel.ForeColor = $muted
  $folderLabel.AutoSize = $true
  $folderLabel.Location = New-Object Drawing.Point(23, 82)
  $dialog.Controls.Add($folderLabel)

  $folderBox = New-Object Windows.Forms.TextBox
  $folderBox.Location = New-Object Drawing.Point(26, 104)
  $folderBox.Size = New-Object Drawing.Size(722, 30)
  $folderBox.BackColor = $surface2
  $folderBox.ForeColor = $text
  $folderBox.BorderStyle = "FixedSingle"
  $dialog.Controls.Add($folderBox)

  $browseFolderButton = New-Object Windows.Forms.Button
  $browseFolderButton.Text = "CHỌN..."
  $browseFolderButton.Size = New-Object Drawing.Size(120, 30)
  $browseFolderButton.Location = New-Object Drawing.Point(754, 103)
  $browseFolderButton.FlatStyle = "Flat"
  $browseFolderButton.BackColor = $surface2
  $browseFolderButton.ForeColor = $text
  $browseFolderButton.FlatAppearance.BorderColor = $border
  $dialog.Controls.Add($browseFolderButton)

  $courseTitleLabel = New-Object Windows.Forms.Label
  $courseTitleLabel.Text = "TÊN KHÓA HỌC"
  $courseTitleLabel.ForeColor = $muted
  $courseTitleLabel.AutoSize = $true
  $courseTitleLabel.Location = New-Object Drawing.Point(23, 147)
  $dialog.Controls.Add($courseTitleLabel)

  $courseTitleBox = New-Object Windows.Forms.TextBox
  $courseTitleBox.Location = New-Object Drawing.Point(26, 169)
  $courseTitleBox.Size = New-Object Drawing.Size(548, 30)
  $courseTitleBox.BackColor = $surface2
  $courseTitleBox.ForeColor = $text
  $courseTitleBox.BorderStyle = "FixedSingle"
  $courseTitleBox.MaxLength = 100
  $dialog.Controls.Add($courseTitleBox)

  $courseIdLabel = New-Object Windows.Forms.Label
  $courseIdLabel.Text = "MÃ KHÓA"
  $courseIdLabel.ForeColor = $muted
  $courseIdLabel.AutoSize = $true
  $courseIdLabel.Location = New-Object Drawing.Point(591, 147)
  $dialog.Controls.Add($courseIdLabel)

  $courseIdBox = New-Object Windows.Forms.TextBox
  $courseIdBox.Location = New-Object Drawing.Point(594, 169)
  $courseIdBox.Size = New-Object Drawing.Size(280, 30)
  $courseIdBox.BackColor = $surface2
  $courseIdBox.ForeColor = $text
  $courseIdBox.BorderStyle = "FixedSingle"
  $courseIdBox.MaxLength = 80
  $dialog.Controls.Add($courseIdBox)

  $preferVietnameseBox = New-Object Windows.Forms.CheckBox
  $preferVietnameseBox.Text = "Ưu tiên bản lồng tiếng Việt"
  $preferVietnameseBox.Checked = $true
  $preferVietnameseBox.AutoSize = $true
  $preferVietnameseBox.Location = New-Object Drawing.Point(26, 216)
  $preferVietnameseBox.FlatStyle = "Flat"
  $dialog.Controls.Add($preferVietnameseBox)

  $reuseHlsBox = New-Object Windows.Forms.CheckBox
  $reuseHlsBox.Text = "Tái sử dụng .m3u8 + .ts có sẵn"
  $reuseHlsBox.Checked = $true
  $reuseHlsBox.AutoSize = $true
  $reuseHlsBox.Location = New-Object Drawing.Point(280, 216)
  $reuseHlsBox.FlatStyle = "Flat"
  $dialog.Controls.Add($reuseHlsBox)

  $scanFolderButton = New-Object Windows.Forms.Button
  $scanFolderButton.Text = "QUÉT THƯ MỤC"
  $scanFolderButton.Size = New-Object Drawing.Size(140, 34)
  $scanFolderButton.Location = New-Object Drawing.Point(734, 209)
  $scanFolderButton.FlatStyle = "Flat"
  $scanFolderButton.BackColor = $discord
  $scanFolderButton.ForeColor = $text
  $scanFolderButton.Font = New-Object Drawing.Font("Segoe UI Semibold", 8.5)
  $scanFolderButton.FlatAppearance.BorderColor = $discord
  $dialog.Controls.Add($scanFolderButton)

  $planLabel = New-Object Windows.Forms.Label
  $planLabel.Text = "CHƯA QUÉT THƯ MỤC"
  $planLabel.Font = New-Object Drawing.Font("Segoe UI Semibold", 9)
  $planLabel.ForeColor = $muted
  $planLabel.AutoSize = $true
  $planLabel.Location = New-Object Drawing.Point(23, 263)
  $dialog.Controls.Add($planLabel)

  $lessonGrid = New-Object Windows.Forms.DataGridView
  $lessonGrid.Location = New-Object Drawing.Point(26, 289)
  $lessonGrid.Size = New-Object Drawing.Size(848, 285)
  $lessonGrid.ReadOnly = $true
  $lessonGrid.AllowUserToAddRows = $false
  $lessonGrid.AllowUserToDeleteRows = $false
  $lessonGrid.AllowUserToResizeRows = $false
  $lessonGrid.AutoGenerateColumns = $false
  $lessonGrid.SelectionMode = "FullRowSelect"
  $lessonGrid.MultiSelect = $false
  $lessonGrid.RowHeadersVisible = $false
  $lessonGrid.BackgroundColor = $surface
  $lessonGrid.BorderStyle = "FixedSingle"
  $lessonGrid.GridColor = $border
  $lessonGrid.EnableHeadersVisualStyles = $false
  $lessonGrid.ColumnHeadersDefaultCellStyle.BackColor = $surface2
  $lessonGrid.ColumnHeadersDefaultCellStyle.ForeColor = $text
  $lessonGrid.ColumnHeadersDefaultCellStyle.Font = New-Object Drawing.Font("Segoe UI Semibold", 8.5)
  $lessonGrid.ColumnHeadersHeight = 36
  $lessonGrid.DefaultCellStyle.BackColor = $surface
  $lessonGrid.DefaultCellStyle.ForeColor = $text
  $lessonGrid.DefaultCellStyle.SelectionBackColor = $discord
  $lessonGrid.DefaultCellStyle.SelectionForeColor = $text
  $lessonGrid.AlternatingRowsDefaultCellStyle.BackColor = $surface2
  $lessonGrid.RowTemplate.Height = 34
  $dialog.Controls.Add($lessonGrid)

  foreach ($columnInfo in @(
    @{ Name = "Bài"; Width = 70 },
    @{ Name = "Tiêu đề"; Width = 440 },
    @{ Name = "Thời lượng"; Width = 100 },
    @{ Name = "Nguồn"; Width = 190 }
  )) {
    $column = New-Object Windows.Forms.DataGridViewTextBoxColumn
    $column.HeaderText = $columnInfo.Name
    $column.Width = $columnInfo.Width
    if ($columnInfo.Name -eq "Tiêu đề") { $column.AutoSizeMode = "Fill" }
    [void]$lessonGrid.Columns.Add($column)
  }

  $closeImportButton = New-Object Windows.Forms.Button
  $closeImportButton.Text = "ĐÓNG"
  $closeImportButton.Size = New-Object Drawing.Size(110, 36)
  $closeImportButton.Location = New-Object Drawing.Point(624, 596)
  $closeImportButton.FlatStyle = "Flat"
  $closeImportButton.BackColor = $surface
  $closeImportButton.ForeColor = $muted
  $closeImportButton.FlatAppearance.BorderColor = $border
  $closeImportButton.DialogResult = [Windows.Forms.DialogResult]::Cancel
  $dialog.Controls.Add($closeImportButton)

  $startImportButton = New-Object Windows.Forms.Button
  $startImportButton.Text = "NHẬP KHÓA"
  $startImportButton.Size = New-Object Drawing.Size(140, 36)
  $startImportButton.Location = New-Object Drawing.Point(734, 596)
  $startImportButton.FlatStyle = "Flat"
  $startImportButton.BackColor = $success
  $startImportButton.ForeColor = $bg
  $startImportButton.Font = New-Object Drawing.Font("Segoe UI Semibold", 9)
  $startImportButton.FlatAppearance.BorderColor = $success
  $startImportButton.Enabled = $false
  $dialog.Controls.Add($startImportButton)

  $invalidatePlan = {
    $dialog.Tag = $null
    $startImportButton.Enabled = $false
    $planLabel.Text = "CẦN QUÉT LẠI THƯ MỤC"
    $planLabel.ForeColor = $muted
  }
  $folderBox.Add_TextChanged($invalidatePlan)
  $courseTitleBox.Add_TextChanged($invalidatePlan)
  $courseIdBox.Add_TextChanged($invalidatePlan)
  $preferVietnameseBox.Add_CheckedChanged($invalidatePlan)
  $reuseHlsBox.Add_CheckedChanged($invalidatePlan)

  $browseFolderButton.Add_Click({
    $picker = New-Object Windows.Forms.FolderBrowserDialog
    $picker.Description = "Chọn thư mục gốc chứa toàn bộ video khóa học"
    $picker.ShowNewFolderButton = $false
    if ([IO.Directory]::Exists($folderBox.Text)) { $picker.SelectedPath = $folderBox.Text }
    if ($picker.ShowDialog($dialog) -eq [Windows.Forms.DialogResult]::OK) {
      $folderBox.Text = $picker.SelectedPath
      $name = [IO.Path]::GetFileName($picker.SelectedPath.TrimEnd('\'))
      $courseTitleBox.Text = $name
      $courseIdBox.Text = New-UniqueCourseId $name @($script:Catalog.courses)
    }
    $picker.Dispose()
  })

  $scanFolderButton.Add_Click({
    try {
      $dialog.UseWaitCursor = $true
      $scanFolderButton.Enabled = $false
      $browseFolderButton.Enabled = $false
      $lessonGrid.Rows.Clear()
      $plan = Get-StreamFolderPlan $folderBox.Text.Trim() $courseIdBox.Text.Trim() $courseTitleBox.Text.Trim() $preferVietnameseBox.Checked $reuseHlsBox.Checked
      foreach ($lesson in @($plan.lessons)) {
        $source = if ($lesson.sourceHls) { "HLS có sẵn · $([string]$lesson.language)" } else { "Sẽ băm 1080p · $([string]$lesson.language)" }
        [void]$lessonGrid.Rows.Add([string]$lesson.id, [string]$lesson.title, [string]$lesson.duration, $source)
      }
      $dialog.Tag = $plan
      $planLabel.Text = "$($plan.lessonCount) BÀI  ·  DÙNG LẠI $($plan.reusedCount) HLS  ·  CẦN BĂM $($plan.packageCount)"
      $planLabel.ForeColor = $success
      $startImportButton.Enabled = $true
    } catch {
      $planLabel.Text = "QUÉT THẤT BẠI"
      $planLabel.ForeColor = $danger
      [Windows.Forms.MessageBox]::Show($_.Exception.Message, "Không thể quét thư mục", "OK", "Error") | Out-Null
    } finally {
      $dialog.UseWaitCursor = $false
      $scanFolderButton.Enabled = $true
      $browseFolderButton.Enabled = $true
    }
  })

  $startImportButton.Add_Click({
    if ($null -eq $dialog.Tag) { return }
    try {
      $startInfo = New-StreamImportStartInfo $folderBox.Text.Trim() $courseIdBox.Text.Trim() $courseTitleBox.Text.Trim() $preferVietnameseBox.Checked $reuseHlsBox.Checked $false
      $script:SyncRunning = $true
      $syncButton.Enabled = $false
      $accessButton.Enabled = $false
      $listToolbar.Enabled = $false
      $courseGrid.Enabled = $false
      $editor.Enabled = $false
      $script:ImportCourseId = $courseIdBox.Text.Trim()
      $script:ImportProcess = New-Object Diagnostics.Process
      $script:ImportProcess.StartInfo = $startInfo
      if (-not $script:ImportProcess.Start()) { throw "Không thể khởi chạy tiến trình nhập STREAM." }
      $script:ImportStdoutTask = $script:ImportProcess.StandardOutput.ReadToEndAsync()
      $script:ImportStderrTask = $script:ImportProcess.StandardError.ReadToEndAsync()
      $statusLabel.Text = "Đang nhập khóa STREAM..."
      $statusLabel.ForeColor = $muted
      Write-Log "Bắt đầu nhập STREAM '$($courseTitleBox.Text.Trim())' từ ổ $([IO.Path]::GetPathRoot($folderBox.Text.Trim()))."
      $importTimer.Start()
      $dialog.DialogResult = [Windows.Forms.DialogResult]::OK
      $dialog.Close()
    } catch {
      if ($null -ne $script:ImportProcess) { $script:ImportProcess.Dispose(); $script:ImportProcess = $null }
      $script:ImportStdoutTask = $null
      $script:ImportStderrTask = $null
      $script:ImportCourseId = ""
      $script:SyncRunning = $false
      $syncButton.Enabled = $true
      $accessButton.Enabled = $true
      $listToolbar.Enabled = $true
      $courseGrid.Enabled = $true
      $editor.Enabled = $true
      [Windows.Forms.MessageBox]::Show($_.Exception.Message, "Không thể nhập khóa STREAM", "OK", "Error") | Out-Null
    }
  })

  $dialog.CancelButton = $closeImportButton
  [void]$dialog.ShowDialog($form)
  $dialog.Dispose()
})
$groupBuyButton.Add_Click({
  if ($script:SyncRunning) { return }

  $dialog = New-Object Windows.Forms.Form
  $dialog.Text = "Quản lý GroupBuy"
  $dialog.StartPosition = "CenterParent"
  $dialog.FormBorderStyle = "FixedDialog"
  $dialog.MaximizeBox = $false
  $dialog.MinimizeBox = $false
  $dialog.ShowInTaskbar = $false
  $dialog.ClientSize = New-Object Drawing.Size(920, 720)
  $dialog.BackColor = $bg
  $dialog.ForeColor = $text
  $dialog.Font = New-Object Drawing.Font("Segoe UI", 10)

  $title = New-Object Windows.Forms.Label
  $title.Text = "GROUPBUY"
  $title.Font = New-Object Drawing.Font("Segoe UI Semibold", 14)
  $title.AutoSize = $true
  $title.Location = New-Object Drawing.Point(22, 16)
  $dialog.Controls.Add($title)

  $copy = New-Object Windows.Forms.Label
  $copy.Text = "Tạo bài Discord kèm link khóa học, ảnh, preview và thanh toán 40k / 400k. Đơn không hết hạn."
  $copy.ForeColor = $muted
  $copy.AutoSize = $true
  $copy.Location = New-Object Drawing.Point(23, 47)
  $dialog.Controls.Add($copy)

  function Add-GroupBuyLabel([string]$TextValue, [int]$X, [int]$Y) {
    $label = New-Object Windows.Forms.Label
    $label.Text = $TextValue
    $label.ForeColor = $muted
    $label.AutoSize = $true
    $label.Location = New-Object Drawing.Point($X, $Y)
    $dialog.Controls.Add($label)
  }
  function New-GroupBuyTextBox([int]$X, [int]$Y, [int]$Width, [int]$Height = 30, [bool]$Multiline = $false) {
    $box = New-Object Windows.Forms.TextBox
    $box.Location = New-Object Drawing.Point($X, $Y)
    $box.Size = New-Object Drawing.Size($Width, $Height)
    $box.Multiline = $Multiline
    if ($Multiline) { $box.ScrollBars = "Vertical" }
    $box.BackColor = $surface2
    $box.ForeColor = $text
    $box.BorderStyle = "FixedSingle"
    $dialog.Controls.Add($box)
    $box
  }

  Add-GroupBuyLabel "TÊN KHÓA HỌC" 23 78
  $groupTitleBox = New-GroupBuyTextBox 26 100 868
  $groupTitleBox.MaxLength = 100

  Add-GroupBuyLabel "MÔ TẢ" 23 137
  $groupDescriptionBox = New-GroupBuyTextBox 26 159 868 58 $true
  $groupDescriptionBox.MaxLength = 1000

  Add-GroupBuyLabel "LINK KHÓA HỌC GỐC (HTTPS)" 23 229
  $groupCourseUrlBox = New-GroupBuyTextBox 26 251 868
  $groupCourseUrlBox.MaxLength = 2000

  Add-GroupBuyLabel "LINK ẢNH BÌA (HTTPS)" 23 288
  $groupImageBox = New-GroupBuyTextBox 26 310 424
  $groupImageBox.MaxLength = 2000
  Add-GroupBuyLabel "LINK PREVIEW (HTTPS)" 467 288
  $groupPreviewBox = New-GroupBuyTextBox 470 310 424
  $groupPreviewBox.MaxLength = 2000

  Add-GroupBuyLabel "GIÁ ĐẦY ĐỦ" 23 347
  $groupPriceBox = New-Object Windows.Forms.NumericUpDown
  $groupPriceBox.Location = New-Object Drawing.Point(26, 369)
  $groupPriceBox.Size = New-Object Drawing.Size(205, 30)
  $groupPriceBox.Minimum = 10000
  $groupPriceBox.Maximum = 2000000000
  $groupPriceBox.Increment = 10000
  $groupPriceBox.Value = 400000
  $groupPriceBox.ThousandsSeparator = $true
  $groupPriceBox.BackColor = $surface2
  $groupPriceBox.ForeColor = $text
  $dialog.Controls.Add($groupPriceBox)

  Add-GroupBuyLabel "SỐ NGƯỜI" 252 347
  $groupSlotsBox = New-Object Windows.Forms.NumericUpDown
  $groupSlotsBox.Location = New-Object Drawing.Point(255, 369)
  $groupSlotsBox.Size = New-Object Drawing.Size(120, 30)
  $groupSlotsBox.Minimum = 2
  $groupSlotsBox.Maximum = 100
  $groupSlotsBox.Value = 10
  $groupSlotsBox.BackColor = $surface2
  $groupSlotsBox.ForeColor = $text
  $dialog.Controls.Add($groupSlotsBox)

  $multiContributionHint = New-Object Windows.Forms.Label
  $multiContributionHint.Text = "Mỗi tài khoản có thể góp nhiều suất; mỗi lần bấm sẽ tạo một mã thanh toán mới."
  $multiContributionHint.ForeColor = $success
  $multiContributionHint.AutoSize = $true
  $multiContributionHint.Location = New-Object Drawing.Point(397, 374)
  $dialog.Controls.Add($multiContributionHint)

  $closeButton = New-Object Windows.Forms.Button
  $closeButton.Text = "ĐÓNG"
  $closeButton.Size = New-Object Drawing.Size(110, 36)
  $closeButton.Location = New-Object Drawing.Point(654, 420)
  $closeButton.FlatStyle = "Flat"
  $closeButton.BackColor = $surface
  $closeButton.ForeColor = $muted
  $closeButton.FlatAppearance.BorderColor = $border
  $closeButton.DialogResult = [Windows.Forms.DialogResult]::Cancel
  $dialog.Controls.Add($closeButton)

  $createButton = New-Object Windows.Forms.Button
  $createButton.Text = "TẠO & ĐĂNG"
  $createButton.Size = New-Object Drawing.Size(130, 36)
  $createButton.Location = New-Object Drawing.Point(774, 420)
  $createButton.FlatStyle = "Flat"
  $createButton.BackColor = $discord
  $createButton.ForeColor = $text
  $createButton.Font = New-Object Drawing.Font("Segoe UI Semibold", 9)
  $createButton.FlatAppearance.BorderColor = $discord
  $dialog.Controls.Add($createButton)

  $listLabel = New-Object Windows.Forms.Label
  $listLabel.Text = "GROUPBUY ĐÃ ĐĂNG"
  $listLabel.Font = New-Object Drawing.Font("Segoe UI Semibold", 10)
  $listLabel.AutoSize = $true
  $listLabel.Location = New-Object Drawing.Point(23, 476)
  $dialog.Controls.Add($listLabel)

  $groupGrid = New-Object Windows.Forms.DataGridView
  $groupGrid.Location = New-Object Drawing.Point(26, 504)
  $groupGrid.Size = New-Object Drawing.Size(868, 190)
  $groupGrid.ReadOnly = $true
  $groupGrid.AllowUserToAddRows = $false
  $groupGrid.AllowUserToDeleteRows = $false
  $groupGrid.AllowUserToResizeRows = $false
  $groupGrid.AutoGenerateColumns = $false
  $groupGrid.SelectionMode = "FullRowSelect"
  $groupGrid.MultiSelect = $false
  $groupGrid.RowHeadersVisible = $false
  $groupGrid.BackgroundColor = $surface
  $groupGrid.BorderStyle = "FixedSingle"
  $groupGrid.GridColor = $border
  $groupGrid.EnableHeadersVisualStyles = $false
  $groupGrid.ColumnHeadersDefaultCellStyle.BackColor = $surface2
  $groupGrid.ColumnHeadersDefaultCellStyle.ForeColor = $text
  $groupGrid.ColumnHeadersHeight = 36
  $groupGrid.DefaultCellStyle.BackColor = $surface
  $groupGrid.DefaultCellStyle.ForeColor = $text
  $groupGrid.DefaultCellStyle.SelectionBackColor = $discord
  $groupGrid.DefaultCellStyle.SelectionForeColor = $text
  $groupGrid.AlternatingRowsDefaultCellStyle.BackColor = $surface2
  $groupGrid.RowTemplate.Height = 36
  $dialog.Controls.Add($groupGrid)

  foreach ($columnInfo in @(
    @{ Name = "Khóa học"; Width = 300 },
    @{ Name = "Giá"; Width = 110 },
    @{ Name = "Tiến độ"; Width = 90 },
    @{ Name = "Trạng thái"; Width = 130 },
    @{ Name = "Link khóa"; Width = 230 }
  )) {
    $column = New-Object Windows.Forms.DataGridViewTextBoxColumn
    $column.HeaderText = $columnInfo.Name
    $column.Width = $columnInfo.Width
    if ($columnInfo.Name -eq "Link khóa") { $column.AutoSizeMode = "Fill" }
    [void]$groupGrid.Columns.Add($column)
  }

  $setBusy = {
    param([bool]$Busy)
    $dialog.UseWaitCursor = $Busy
    foreach ($control in @($groupTitleBox, $groupDescriptionBox, $groupCourseUrlBox, $groupImageBox, $groupPreviewBox, $groupPriceBox, $groupSlotsBox, $createButton, $closeButton)) {
      $control.Enabled = -not $Busy
    }
  }
  $refreshList = {
    & $setBusy $true
    try {
      $groupGrid.Rows.Clear()
      foreach ($campaign in @(Get-GroupBuyCampaigns)) {
        $status = switch ([string]$campaign.status) { "funded" { "Đủ người" } "exclusive" { "Độc quyền" } default { "Đang mở" } }
        [void]$groupGrid.Rows.Add(
          [string]$campaign.title,
          ("{0:N0}đ" -f [decimal]$campaign.totalPrice),
          ("{0}/{1}" -f [int]$campaign.paidSlots, [int]$campaign.targetSlots),
          $status,
          [string]$campaign.courseUrl
        )
      }
      $listLabel.Text = "GROUPBUY ĐÃ ĐĂNG  ·  $($groupGrid.Rows.Count)"
      $groupGrid.ClearSelection()
    } catch {
      Write-Log "LỖI TẢI GROUPBUY: $($_.Exception.Message)"
      [Windows.Forms.MessageBox]::Show($_.Exception.Message, "Không thể tải GroupBuy", "OK", "Error") | Out-Null
    } finally {
      & $setBusy $false
    }
  }

  $createButton.Add_Click({
    $courseUrl = $groupCourseUrlBox.Text.Trim()
    $imageUrl = $groupImageBox.Text.Trim()
    $previewUrl = $groupPreviewBox.Text.Trim()
    $price = [int64]$groupPriceBox.Value
    $slots = [int]$groupSlotsBox.Value
    if (-not $groupTitleBox.Text.Trim() -or -not $courseUrl -or -not (Test-HttpsUrl $courseUrl 2000) -or
        -not (Test-HttpsUrl $imageUrl 2000) -or -not (Test-HttpsUrl $previewUrl 2000) -or $price % $slots -ne 0) {
      [Windows.Forms.MessageBox]::Show("Nhập tên, link khóa HTTPS hợp lệ; giá phải chia đều cho số người.", "Dữ liệu chưa hợp lệ", "OK", "Warning") | Out-Null
      return
    }
    try {
      & $setBusy $true
      $created = New-GroupBuyCampaign ([pscustomobject][ordered]@{
        title = $groupTitleBox.Text.Trim()
        description = $groupDescriptionBox.Text.Trim()
        courseUrl = $courseUrl
        imageUrl = $imageUrl
        previewUrl = $previewUrl
        totalPrice = $price
        targetSlots = $slots
      })
      $statusLabel.Text = "Đã đăng GroupBuy."
      $statusLabel.ForeColor = $success
      Write-Log "GROUPBUY: $([string]$created.discordUrl)"
      [Windows.Forms.MessageBox]::Show("Đã đăng GroupBuy:`r`n$([string]$created.discordUrl)", "Hoàn tất", "OK", "Information") | Out-Null
      $groupTitleBox.Clear()
      $groupDescriptionBox.Clear()
      $groupCourseUrlBox.Clear()
      $groupImageBox.Clear()
      $groupPreviewBox.Clear()
      & $refreshList
    } catch {
      $statusLabel.Text = "Đăng GroupBuy thất bại."
      $statusLabel.ForeColor = $danger
      Write-Log "LỖI GROUPBUY: $($_.Exception.Message)"
      [Windows.Forms.MessageBox]::Show($_.Exception.Message, "Không thể đăng GroupBuy", "OK", "Error") | Out-Null
    } finally {
      if (-not $dialog.IsDisposed) { & $setBusy $false }
    }
  })

  $dialog.AcceptButton = $createButton
  $dialog.CancelButton = $closeButton
  & $refreshList
  [void]$groupTitleBox.Focus()
  [void]$dialog.ShowDialog($form)
  $dialog.Dispose()
})
$accessButton.Add_Click({
  if ($script:SyncRunning) { return }
  $options = @(Get-GoogleAccessOptions)

  $dialog = New-Object Windows.Forms.Form
  $dialog.Text = "Quản lý quyền truy cập Google"
  $dialog.StartPosition = "CenterParent"
  $dialog.FormBorderStyle = "FixedDialog"
  $dialog.MaximizeBox = $false
  $dialog.MinimizeBox = $false
  $dialog.ShowInTaskbar = $false
  $dialog.ClientSize = New-Object Drawing.Size(860, 620)
  $dialog.BackColor = $bg
  $dialog.ForeColor = $text
  $dialog.Font = New-Object Drawing.Font("Segoe UI", 10)

  $accessTitle = New-Object Windows.Forms.Label
  $accessTitle.Text = "QUẢN LÝ QUYỀN EMAIL"
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
  $accessEmailBox.Size = New-Object Drawing.Size(808, 30)
  $accessEmailBox.BackColor = $surface2
  $accessEmailBox.ForeColor = $text
  $accessEmailBox.BorderStyle = "FixedSingle"
  $accessEmailBox.MaxLength = 254
  $dialog.Controls.Add($accessEmailBox)

  $accessScopeLabel = New-Object Windows.Forms.Label
  $accessScopeLabel.Text = "KHÓA STREAM"
  $accessScopeLabel.ForeColor = $muted
  $accessScopeLabel.AutoSize = $true
  $accessScopeLabel.Location = New-Object Drawing.Point(23, 145)
  $dialog.Controls.Add($accessScopeLabel)

  $accessScopeBox = New-Object Windows.Forms.ComboBox
  $accessScopeBox.Location = New-Object Drawing.Point(26, 168)
  $accessScopeBox.Size = New-Object Drawing.Size(808, 32)
  $accessScopeBox.DropDownStyle = "DropDownList"
  $accessScopeBox.BackColor = $surface2
  $accessScopeBox.ForeColor = $text
  $accessScopeBox.DisplayMember = "Label"
  foreach ($option in $options) { [void]$accessScopeBox.Items.Add($option) }
  if ($options.Count -gt 0) { $accessScopeBox.SelectedIndex = 0 }
  $dialog.Controls.Add($accessScopeBox)

  $accessHint = New-Object Windows.Forms.Label
  $accessHint.ForeColor = $muted
  $accessHint.Size = New-Object Drawing.Size(538, 36)
  $accessHint.Location = New-Object Drawing.Point(23, 207)
  $dialog.Controls.Add($accessHint)
  $accessHint.Text = "Quyền mua lẻ không hết hạn. Gmail có thể cấp trước; Workspace cần đăng nhập Google một lần."

  $closeAccessButton = New-Object Windows.Forms.Button
  $closeAccessButton.Text = "ĐÓNG"
  $closeAccessButton.Size = New-Object Drawing.Size(110, 36)
  $closeAccessButton.Location = New-Object Drawing.Point(594, 256)
  $closeAccessButton.FlatStyle = "Flat"
  $closeAccessButton.BackColor = $surface
  $closeAccessButton.ForeColor = $muted
  $closeAccessButton.FlatAppearance.BorderColor = $border
  $closeAccessButton.DialogResult = [Windows.Forms.DialogResult]::Cancel
  $dialog.Controls.Add($closeAccessButton)

  $grantAccessButton = New-Object Windows.Forms.Button
  $grantAccessButton.Text = "CẤP QUYỀN"
  $grantAccessButton.Size = New-Object Drawing.Size(120, 36)
  $grantAccessButton.Location = New-Object Drawing.Point(714, 256)
  $grantAccessButton.FlatStyle = "Flat"
  $grantAccessButton.BackColor = $success
  $grantAccessButton.ForeColor = $bg
  $grantAccessButton.Font = New-Object Drawing.Font("Segoe UI Semibold", 9)
  $grantAccessButton.FlatAppearance.BorderColor = $success
  $grantAccessButton.Enabled = $options.Count -gt 0
  $dialog.Controls.Add($grantAccessButton)

  $approvedLabel = New-Object Windows.Forms.Label
  $approvedLabel.Text = "EMAIL ĐÃ ĐƯỢC DUYỆT"
  $approvedLabel.Font = New-Object Drawing.Font("Segoe UI Semibold", 10)
  $approvedLabel.AutoSize = $true
  $approvedLabel.Location = New-Object Drawing.Point(23, 320)
  $dialog.Controls.Add($approvedLabel)

  $accessGrid = New-Object Windows.Forms.DataGridView
  $accessGrid.Location = New-Object Drawing.Point(26, 348)
  $accessGrid.Size = New-Object Drawing.Size(808, 202)
  $accessGrid.ReadOnly = $true
  $accessGrid.AllowUserToAddRows = $false
  $accessGrid.AllowUserToDeleteRows = $false
  $accessGrid.AllowUserToResizeRows = $false
  $accessGrid.AutoGenerateColumns = $false
  $accessGrid.SelectionMode = "FullRowSelect"
  $accessGrid.MultiSelect = $false
  $accessGrid.RowHeadersVisible = $false
  $accessGrid.BackgroundColor = $surface
  $accessGrid.BorderStyle = "FixedSingle"
  $accessGrid.GridColor = $border
  $accessGrid.EnableHeadersVisualStyles = $false
  $accessGrid.ColumnHeadersDefaultCellStyle.BackColor = $surface2
  $accessGrid.ColumnHeadersDefaultCellStyle.ForeColor = $text
  $accessGrid.ColumnHeadersDefaultCellStyle.Font = New-Object Drawing.Font("Segoe UI Semibold", 8.5)
  $accessGrid.ColumnHeadersHeight = 36
  $accessGrid.DefaultCellStyle.BackColor = $surface
  $accessGrid.DefaultCellStyle.ForeColor = $text
  $accessGrid.DefaultCellStyle.SelectionBackColor = $discord
  $accessGrid.DefaultCellStyle.SelectionForeColor = $text
  $accessGrid.AlternatingRowsDefaultCellStyle.BackColor = $surface2
  $accessGrid.RowTemplate.Height = 36
  $dialog.Controls.Add($accessGrid)

  foreach ($columnInfo in @(
    @{ Name = "Email"; Width = 220 },
    @{ Name = "Khóa học"; Width = 315 },
    @{ Name = "Trạng thái"; Width = 115 },
    @{ Name = "Ngày cấp"; Width = 150 }
  )) {
    $column = New-Object Windows.Forms.DataGridViewTextBoxColumn
    $column.HeaderText = $columnInfo.Name
    $column.Width = $columnInfo.Width
    if ($columnInfo.Name -eq "Khóa học") { $column.AutoSizeMode = "Fill" }
    [void]$accessGrid.Columns.Add($column)
  }

  $refreshAccessButton = New-Object Windows.Forms.Button
  $refreshAccessButton.Text = "LÀM MỚI"
  $refreshAccessButton.Size = New-Object Drawing.Size(110, 36)
  $refreshAccessButton.Location = New-Object Drawing.Point(594, 568)
  $refreshAccessButton.FlatStyle = "Flat"
  $refreshAccessButton.BackColor = $surface
  $refreshAccessButton.ForeColor = $muted
  $refreshAccessButton.FlatAppearance.BorderColor = $border
  $dialog.Controls.Add($refreshAccessButton)

  $revokeAccessButton = New-Object Windows.Forms.Button
  $revokeAccessButton.Text = "THU HỒI"
  $revokeAccessButton.Size = New-Object Drawing.Size(120, 36)
  $revokeAccessButton.Location = New-Object Drawing.Point(714, 568)
  $revokeAccessButton.FlatStyle = "Flat"
  $revokeAccessButton.BackColor = $surface
  $revokeAccessButton.ForeColor = $danger
  $revokeAccessButton.Font = New-Object Drawing.Font("Segoe UI Semibold", 9)
  $revokeAccessButton.FlatAppearance.BorderColor = $danger
  $revokeAccessButton.Enabled = $false
  $dialog.Controls.Add($revokeAccessButton)

  $setAccessBusy = {
    param([bool]$Busy)
    $dialog.UseWaitCursor = $Busy
    $accessEmailBox.Enabled = -not $Busy
    $accessScopeBox.Enabled = (-not $Busy) -and $options.Count -gt 0
    $grantAccessButton.Enabled = (-not $Busy) -and $options.Count -gt 0
    $closeAccessButton.Enabled = -not $Busy
    $refreshAccessButton.Enabled = -not $Busy
    $revokeAccessButton.Enabled = (-not $Busy) -and $accessGrid.SelectedRows.Count -gt 0
  }

  $refreshAccessList = {
    & $setAccessBusy $true
    try {
      $accessGrid.Rows.Clear()
      foreach ($grant in @(Get-GoogleAccessGrants)) {
        $grantedAt = ""
        if ($grant.grantedAt) {
          try { $grantedAt = ([DateTimeOffset]::Parse([string]$grant.grantedAt)).ToLocalTime().ToString("dd/MM/yyyy HH:mm") } catch { $grantedAt = [string]$grant.grantedAt }
        }
        $linked = if ($grant.linked -eq $true) { "Đã liên kết" } else { "Chưa đăng nhập" }
        $rowIndex = $accessGrid.Rows.Add([string]$grant.email, [string]$grant.courseTitle, $linked, $grantedAt)
        $accessGrid.Rows[$rowIndex].Tag = [string]$grant.id
      }
      $approvedLabel.Text = "EMAIL ĐÃ ĐƯỢC DUYỆT  ·  $($accessGrid.Rows.Count)"
      $accessGrid.ClearSelection()
    } catch {
      Write-Log "LỖI TẢI QUYỀN EMAIL: $($_.Exception.Message)"
      [Windows.Forms.MessageBox]::Show($_.Exception.Message, "Không thể tải danh sách", "OK", "Error") | Out-Null
    } finally {
      & $setAccessBusy $false
    }
  }

  $accessGrid.Add_SelectionChanged({
    if (-not $dialog.UseWaitCursor) { $revokeAccessButton.Enabled = $accessGrid.SelectedRows.Count -gt 0 }
  })
  $refreshAccessButton.Add_Click({ & $refreshAccessList })

  $grantAccessButton.Add_Click({
    $email = Normalize-GoogleAccessEmail $accessEmailBox.Text
    $selected = $accessScopeBox.SelectedItem
    if (-not $email -or $null -eq $selected) {
      [Windows.Forms.MessageBox]::Show("Hãy nhập đúng một email Google và chọn khóa STREAM.", "Dữ liệu chưa hợp lệ", "OK", "Warning") | Out-Null
      return
    }
    try {
      & $setAccessBusy $true
      $output = Invoke-GoogleAccessGrant $email ([string]$selected.Value)
      $statusLabel.Text = "Đã cấp quyền Google."
      $statusLabel.ForeColor = $success
      Write-Log "CẤP QUYỀN: $output"
      [Windows.Forms.MessageBox]::Show($output, "Đã cấp quyền", "OK", "Information") | Out-Null
      $accessEmailBox.Clear()
      & $refreshAccessList
    } catch {
      $statusLabel.Text = "Cấp quyền chưa hoàn tất."
      $statusLabel.ForeColor = $danger
      Write-Log "LỖI CẤP QUYỀN: $($_.Exception.Message)"
      [Windows.Forms.MessageBox]::Show($_.Exception.Message, "Không thể cấp quyền", "OK", "Error") | Out-Null
    } finally {
      if (-not $dialog.IsDisposed) {
        & $setAccessBusy $false
      }
    }
  })

  $revokeAccessButton.Add_Click({
    if ($accessGrid.SelectedRows.Count -eq 0) { return }
    $row = $accessGrid.SelectedRows[0]
    $grantId = [string]$row.Tag
    $email = [string]$row.Cells[0].Value
    $courseTitle = [string]$row.Cells[1].Value
    $choice = [Windows.Forms.MessageBox]::Show(
      "Thu hồi quyền của $email đối với khóa `"$courseTitle`"?`r`n`r`nTiến độ học vẫn được giữ lại.",
      "Xác nhận thu hồi", "YesNo", "Warning"
    )
    if ($choice -ne [Windows.Forms.DialogResult]::Yes) { return }
    try {
      & $setAccessBusy $true
      $output = Revoke-GoogleAccessGrant $grantId
      $statusLabel.Text = "Đã thu hồi quyền email."
      $statusLabel.ForeColor = $success
      Write-Log "THU HỒI QUYỀN: $output"
      & $refreshAccessList
    } catch {
      $statusLabel.Text = "Thu hồi quyền chưa hoàn tất."
      $statusLabel.ForeColor = $danger
      Write-Log "LỖI THU HỒI QUYỀN: $($_.Exception.Message)"
      [Windows.Forms.MessageBox]::Show($_.Exception.Message, "Không thể thu hồi quyền", "OK", "Error") | Out-Null
    } finally {
      if (-not $dialog.IsDisposed) { & $setAccessBusy $false }
    }
  })

  $dialog.AcceptButton = $grantAccessButton
  $dialog.CancelButton = $closeAccessButton
  & $refreshAccessList
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
    $groupBuyButton.Enabled = $false
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
    $groupBuyButton.Enabled = $true
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
    $deliveryMode = switch ($deliveryBox.SelectedIndex) { 1 { "DRIVE" } 2 { "STREAM" } 3 { "RVP_DEVICE" } default { "NON-STREAM" } }
    $driveFolderValue = $driveFolderBox.Text.Trim()
    $driveFolderId = if ($deliveryMode -in @("DRIVE", "RVP_DEVICE")) { Resolve-DriveFolderId $driveFolderValue } else { "" }
    $editingCourse = if ($script:EditingCourseId) {
      @($script:Catalog.courses) | Where-Object { [string]$_.id -eq $script:EditingCourseId } | Select-Object -First 1
    } else { $null }
    $hasPublishedLesson = $null -ne $editingCourse -and @($editingCourse.lessons | Where-Object { $_.published -eq $true }).Count -gt 0
    $hasRvpPackage = $null -ne $editingCourse -and $editingCourse.rvpAvailable -eq $true
    $errorMessage = Get-CourseValidationError $title $description $price $planTier $rightsBox.Checked $publishedBox.Checked $saleBox.Checked $deliveryMode $hasPublishedLesson $driveFolderValue $imageUrl $previewUrl $freeBox.Checked $hasRvpPackage
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
        freeAccess = $false
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
    if ($deliveryMode -ne "RVP_DEVICE") { Set-CourseProperty $course "rvpAvailable" $false }
    Set-CourseProperty $course "saleEnabled" ([bool]$saleBox.Checked)
    Set-CourseProperty $course "freeAccess" ([bool]$freeBox.Checked)
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
    [Windows.Forms.MessageBox]::Show("Hệ thống đang xử lý. Hãy chờ tiến trình hoàn tất.", "Nixart", "OK", "Information") | Out-Null
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
    if ($deliveryBox.Items.Count -ne 4) { throw "Danh sách hình thức học phải có NON-STREAM, DRIVE, STREAM và RVP_DEVICE." }
    $deliveryBox.SelectedIndex = 3
    if (-not $driveFolderBox.Enabled) { throw "Ô Drive phải mở khi chọn RVP_DEVICE." }
    if ($driveFolderBox.Top -lt $deliveryBox.Bottom) { throw "Ô thư mục Drive đang chồng lên danh sách hình thức học." }
    if ($courseGrid.RowTemplate.Height -ne 40) { throw "Hàng catalog phải cao 40px." }
    if ($saveButton.Bottom -gt $editorHeader.ClientSize.Height -or $cancelButton.Bottom -gt $editorHeader.ClientSize.Height) { throw "Nút lưu hoặc hủy nằm ngoài header trình sửa." }
    if ($deleteButton.Parent -ne $listToolbar -or $importButton.Parent -ne $listToolbar -or
        $importButton.Bounds.IntersectsWith($newButton.Bounds) -or $newButton.Bounds.IntersectsWith($deleteButton.Bounds)) {
      throw "Các nút catalog sai vị trí hoặc đang chồng nhau."
    }
    if ($deleteButton.Enabled) { throw "Nút xóa phải tắt khi chưa chọn khóa học." }
    if ($groupBuyButton.Parent -ne $header -or $accessButton.Parent -ne $header -or
        $statusLabel.Bounds.IntersectsWith($groupBuyButton.Bounds) -or $groupBuyButton.Bounds.IntersectsWith($accessButton.Bounds) -or
        $accessButton.Bounds.IntersectsWith($syncButton.Bounds)) { throw "Các nút header sai vị trí hoặc đang chồng nhau." }
    if ($statusLabel.Bottom -gt $header.ClientSize.Height -or $groupBuyButton.Bottom -gt $header.ClientSize.Height -or $accessButton.Bottom -gt $header.ClientSize.Height -or $syncButton.Bottom -gt $header.ClientSize.Height) { throw "Điều khiển header nằm ngoài khung." }
    $accessOptions = @(Get-GoogleAccessOptions)
    if (@($accessOptions | Where-Object { [string]$_.Value -cnotmatch '^[a-z0-9][a-z0-9_-]{0,79}$' }).Count -gt 0) { throw "Danh sách cấp quyền chỉ được chứa khóa STREAM hợp lệ." }
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

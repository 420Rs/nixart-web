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
$script:Utf8NoBom = New-Object Text.UTF8Encoding($false)
$script:Catalog = $null
$script:CatalogFingerprint = ""
$script:EditingCourseId = ""
$script:SyncRunning = $false
$script:SyncProcess = $null
$script:SyncStdoutTask = $null
$script:SyncStderrTask = $null

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

function Get-CourseValidationError {
  param(
    [string]$Title,
    [string]$Description,
    [decimal]$Price,
    [string]$PlanTier,
    [bool]$RightsVerified,
    [bool]$Published,
    [bool]$SaleEnabled,
    [bool]$StreamAvailable,
    [bool]$HasPublishedLesson,
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
  if ($Published -and -not $RightsVerified) { return "Muốn công khai trên web, bạn phải xác nhận quyền phân phối khóa học." }
  if ($SaleEnabled -and -not $Published) { return "Muốn mở thanh toán, khóa học phải được công khai trên web." }
  if ($SaleEnabled -and -not $RightsVerified) { return "Muốn mở thanh toán, bạn phải xác nhận quyền phân phối khóa học." }
  if ($SaleEnabled -and -not $StreamAvailable) { return "Muốn mở thanh toán, hình thức học phải là STREAM để người mua xem được trên web." }
  if ($SaleEnabled -and -not $HasPublishedLesson) { return "Muốn mở thanh toán, khóa học phải có ít nhất một bài HLS đã published." }
  if ($SaleEnabled -and $Price -le 0) { return "Muốn mở thanh toán, giá khóa học phải lớn hơn 0." }
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
  if (-not (Get-CourseValidationError "A" "" 100 "full" $false $true $false $false $false "" "")) { throw "Kiểm tra quyền công khai thất bại" }
  if (-not (Get-CourseValidationError "A" "" 100 "full" $true $true $true $false $true "" "")) { throw "Kiểm tra STREAM thanh toán thất bại" }
  if (-not (Get-CourseValidationError "A" "" 100 "full" $true $true $true $true $false "" "")) { throw "Kiểm tra bài HLS thanh toán thất bại" }
  if (Get-CourseValidationError "A" "" 0 "full" $true $true $false $false $false "" "") { throw "Khóa NON-STREAM hợp lệ không thể công khai" }

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
$accent = [Drawing.Color]::FromArgb(245, 245, 246)

$form = New-Object Windows.Forms.Form
$form.Text = "Nixart Course Manager"
$form.StartPosition = "CenterScreen"
$form.ClientSize = New-Object Drawing.Size(1180, 800)
$form.MinimumSize = New-Object Drawing.Size(1050, 760)
$form.BackColor = $bg
$form.ForeColor = $text
$form.Font = New-Object Drawing.Font("Segoe UI", 10)

$header = New-Object Windows.Forms.Panel
$header.Dock = "Top"
$header.Height = 68
$header.Padding = New-Object Windows.Forms.Padding(22, 12, 22, 8)
$header.BackColor = $bg
$form.Controls.Add($header)

$heading = New-Object Windows.Forms.Label
$heading.Text = "NIXART  //  COURSE MANAGER"
$heading.Font = New-Object Drawing.Font("Segoe UI Semibold", 15)
$heading.AutoSize = $true
$heading.Location = New-Object Drawing.Point(20, 10)
$header.Controls.Add($heading)

$subheading = New-Object Windows.Forms.Label
$subheading.Text = "Lưu cập nhật catalog trên web ngay; đồng bộ Discord là bước riêng."
$subheading.ForeColor = $muted
$subheading.AutoSize = $true
$subheading.Location = New-Object Drawing.Point(22, 40)
$header.Controls.Add($subheading)

$outputGroup = New-Object Windows.Forms.GroupBox
$outputGroup.Text = "  Nhật ký  "
$outputGroup.Dock = "Bottom"
$outputGroup.Height = 180
$outputGroup.Padding = New-Object Windows.Forms.Padding(12)
$outputGroup.ForeColor = $text
$form.Controls.Add($outputGroup)

$syncBar = New-Object Windows.Forms.Panel
$syncBar.Dock = "Top"
$syncBar.Height = 44
$outputGroup.Controls.Add($syncBar)

$syncButton = New-Object Windows.Forms.Button
$syncButton.Text = "ĐỒNG BỘ LÊN DISCORD"
$syncButton.Size = New-Object Drawing.Size(220, 34)
$syncButton.Location = New-Object Drawing.Point(0, 2)
$syncButton.FlatStyle = "Flat"
$syncButton.BackColor = $success
$syncButton.ForeColor = $bg
$syncButton.Font = New-Object Drawing.Font("Segoe UI Semibold", 9)
$syncButton.FlatAppearance.BorderColor = $success
$syncBar.Controls.Add($syncButton)

$statusLabel = New-Object Windows.Forms.Label
$statusLabel.Text = "Chưa có thay đổi mới."
$statusLabel.ForeColor = $muted
$statusLabel.AutoSize = $true
$statusLabel.Location = New-Object Drawing.Point(235, 11)
$syncBar.Controls.Add($statusLabel)

$outputBox = New-Object Windows.Forms.RichTextBox
$outputBox.Dock = "Fill"
$outputBox.ReadOnly = $true
$outputBox.BackColor = $surface
$outputBox.ForeColor = $text
$outputBox.BorderStyle = "FixedSingle"
$outputBox.Font = New-Object Drawing.Font("Cascadia Mono", 9)
$outputGroup.Controls.Add($outputBox)
$outputBox.BringToFront()

$split = New-Object Windows.Forms.SplitContainer
$split.Dock = "Fill"
$split.SplitterWidth = 8
$split.BackColor = $bg
$form.Controls.Add($split)
$split.SplitterDistance = 650
$split.BringToFront()

$listGroup = New-Object Windows.Forms.GroupBox
$listGroup.Text = "  Các khóa học hiện có  "
$listGroup.Dock = "Fill"
$listGroup.Padding = New-Object Windows.Forms.Padding(12)
$listGroup.ForeColor = $text
$split.Panel1.Controls.Add($listGroup)

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
$courseGrid.DefaultCellStyle.BackColor = $surface
$courseGrid.DefaultCellStyle.ForeColor = $text
$courseGrid.DefaultCellStyle.SelectionBackColor = $border
$courseGrid.DefaultCellStyle.SelectionForeColor = $text
$listGroup.Controls.Add($courseGrid)

foreach ($columnInfo in @(
  @{ Name = "Tên khóa học"; Width = 260 },
  @{ Name = "Giá"; Width = 95 },
  @{ Name = "Gói"; Width = 65 },
  @{ Name = "Hình thức"; Width = 115 },
  @{ Name = "Quyền"; Width = 70 },
  @{ Name = "Web"; Width = 60 },
  @{ Name = "Mở bán"; Width = 75 }
)) {
  $column = New-Object Windows.Forms.DataGridViewTextBoxColumn
  $column.HeaderText = $columnInfo.Name
  $column.Width = $columnInfo.Width
  if ($columnInfo.Name -eq "Tên khóa học") { $column.AutoSizeMode = "Fill" }
  [void]$courseGrid.Columns.Add($column)
}

$editor = New-Object Windows.Forms.GroupBox
$editor.Text = "  Thông tin khóa học  "
$editor.Dock = "Top"
$editor.Height = 550
$editor.Padding = New-Object Windows.Forms.Padding(16)
$editor.ForeColor = $text
$split.Panel2.AutoScroll = $true
$split.Panel2.Controls.Add($editor)

$newButton = New-Object Windows.Forms.Button
$newButton.Text = "+ KHÓA MỚI"
$newButton.Size = New-Object Drawing.Size(115, 30)
$newButton.Location = New-Object Drawing.Point(18, 24)
$newButton.FlatStyle = "Flat"
$newButton.BackColor = $surface2
$newButton.ForeColor = $text
$newButton.FlatAppearance.BorderColor = $border
$editor.Controls.Add($newButton)

$idLabel = New-Object Windows.Forms.Label
$idLabel.Text = "Mã: sẽ tạo khi lưu"
$idLabel.ForeColor = $muted
$idLabel.AutoSize = $true
$idLabel.Location = New-Object Drawing.Point(145, 31)
$editor.Controls.Add($idLabel)

function Add-EditorLabel {
  param([string]$Caption, [int]$Top, [int]$Left = 18)
  $label = New-Object Windows.Forms.Label
  $label.Text = $Caption
  $label.AutoSize = $true
  $label.Location = New-Object Drawing.Point($Left, $Top)
  $editor.Controls.Add($label)
}

function New-EditorTextBox {
  param([int]$Top, [int]$Height = 28, [bool]$Multiline = $false)
  $box = New-Object Windows.Forms.TextBox
  $box.Location = New-Object Drawing.Point(18, $Top)
  $box.Size = New-Object Drawing.Size(430, $Height)
  $box.Anchor = "Top, Left, Right"
  $box.BackColor = $surface
  $box.ForeColor = $text
  $box.BorderStyle = "FixedSingle"
  $box.Multiline = $Multiline
  $editor.Controls.Add($box)
  $box
}

Add-EditorLabel "Tên khóa học *" 62
$titleBox = New-EditorTextBox 82
$titleBox.MaxLength = 100

Add-EditorLabel "Mô tả" 114
$descriptionBox = New-EditorTextBox 134 58 $true
$descriptionBox.MaxLength = 4000
$descriptionBox.ScrollBars = "Vertical"

Add-EditorLabel "URL ảnh bìa (HTTPS)" 200
$imageUrlBox = New-EditorTextBox 220
$imageUrlBox.MaxLength = 2000

Add-EditorLabel "Link preview khóa học (HTTPS)" 254
$previewUrlBox = New-EditorTextBox 274
$previewUrlBox.MaxLength = 512

Add-EditorLabel "Giá bán (VNĐ)" 308
$priceBox = New-Object Windows.Forms.NumericUpDown
$priceBox.Location = New-Object Drawing.Point(18, 328)
$priceBox.Size = New-Object Drawing.Size(205, 28)
$priceBox.Maximum = 2000000000
$priceBox.DecimalPlaces = 0
$priceBox.Increment = 10000
$priceBox.ThousandsSeparator = $true
$priceBox.BackColor = $surface
$priceBox.ForeColor = $text
$editor.Controls.Add($priceBox)

Add-EditorLabel "Thuộc gói" 308 243
$planBox = New-Object Windows.Forms.ComboBox
$planBox.Location = New-Object Drawing.Point(243, 328)
$planBox.Size = New-Object Drawing.Size(205, 28)
$planBox.DropDownStyle = "DropDownList"
$planBox.BackColor = $surface
$planBox.ForeColor = $text
[void]$planBox.Items.AddRange(@("basic", "full"))
$planBox.SelectedItem = "full"
$editor.Controls.Add($planBox)

Add-EditorLabel "Hình thức học" 366
$streamBox = New-Object Windows.Forms.ComboBox
$streamBox.Location = New-Object Drawing.Point(18, 386)
$streamBox.Size = New-Object Drawing.Size(430, 28)
$streamBox.Anchor = "Top, Left, Right"
$streamBox.DropDownStyle = "DropDownList"
$streamBox.BackColor = $surface
$streamBox.ForeColor = $text
[void]$streamBox.Items.AddRange(@(
  "NON-STREAM — chưa học trên web",
  "Bật STREAM — chỉ hiện khi có bài HLS published"
))
$streamBox.SelectedIndex = 0
$editor.Controls.Add($streamBox)

$rightsBox = New-Object Windows.Forms.CheckBox
$rightsBox.Text = "Tôi xác nhận có quyền phân phối khóa học"
$rightsBox.AutoSize = $true
$rightsBox.Location = New-Object Drawing.Point(18, 422)
$editor.Controls.Add($rightsBox)

$publishedBox = New-Object Windows.Forms.CheckBox
$publishedBox.Text = "Công khai khóa học trên web"
$publishedBox.AutoSize = $true
$publishedBox.Location = New-Object Drawing.Point(18, 447)
$editor.Controls.Add($publishedBox)

$saleBox = New-Object Windows.Forms.CheckBox
$saleBox.Text = "Mở thanh toán (cần STREAM + ít nhất 1 bài HLS)"
$saleBox.AutoSize = $true
$saleBox.Location = New-Object Drawing.Point(18, 472)
$editor.Controls.Add($saleBox)

$saveButton = New-Object Windows.Forms.Button
$saveButton.Text = "THÊM KHÓA HỌC"
$saveButton.Location = New-Object Drawing.Point(18, 504)
$saveButton.Size = New-Object Drawing.Size(205, 40)
$saveButton.FlatStyle = "Flat"
$saveButton.BackColor = $accent
$saveButton.ForeColor = $bg
$saveButton.Font = New-Object Drawing.Font("Segoe UI Semibold", 10)
$saveButton.FlatAppearance.BorderColor = $accent
$editor.Controls.Add($saveButton)

$saveNote = New-Object Windows.Forms.Label
$saveNote.Text = "Lưu không tự đăng Discord."
$saveNote.ForeColor = $muted
$saveNote.AutoSize = $true
$saveNote.Location = New-Object Drawing.Point(238, 516)
$editor.Controls.Add($saveNote)

function Write-Log {
  param([string]$Message)
  $outputBox.AppendText(("[{0}] {1}{2}" -f (Get-Date -Format "HH:mm:ss"), $Message, [Environment]::NewLine))
  $outputBox.SelectionStart = $outputBox.TextLength
  $outputBox.ScrollToCaret()
}

function Clear-Editor {
  $script:EditingCourseId = ""
  $titleBox.Clear()
  $descriptionBox.Clear()
  $imageUrlBox.Clear()
  $previewUrlBox.Clear()
  $priceBox.Value = 0
  $planBox.SelectedItem = "full"
  $streamBox.SelectedIndex = 0
  $rightsBox.Checked = $false
  $publishedBox.Checked = $false
  $saleBox.Checked = $false
  $idLabel.Text = "Mã: sẽ tạo khi lưu"
  $saveButton.Text = "THÊM KHÓA HỌC"
  $courseGrid.ClearSelection()
  [void]$titleBox.Focus()
}

function Refresh-CourseList {
  param([string]$SelectId = "")

  $snapshot = Get-CatalogSnapshot
  $script:Catalog = $snapshot.Catalog
  $script:CatalogFingerprint = $snapshot.Fingerprint
  $courseGrid.Rows.Clear()
  foreach ($course in @($script:Catalog.courses)) {
    $price = if ([decimal]$course.price -gt 0) { "{0:N0}đ" -f [decimal]$course.price } else { "—" }
    $hasPublishedLesson = @($course.lessons | Where-Object { $_.published -eq $true }).Count -gt 0
    $saleReady = $course.forumVisible -eq $true -and $course.published -eq $true -and $course.saleEnabled -eq $true -and $course.rightsVerified -eq $true -and
      $course.streamAvailable -eq $true -and [decimal]$course.price -gt 0 -and $hasPublishedLesson
    $rowIndex = $courseGrid.Rows.Add(
      [string]$course.title,
      $price,
      [string]$course.planTier,
      $(if ($course.published -eq $true -and $course.rightsVerified -eq $true -and $course.streamAvailable -eq $true -and $hasPublishedLesson) { "STREAM" } else { "NON-STREAM" }),
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
  $streamBox.SelectedIndex = if ($course.streamAvailable -eq $true) { 1 } else { 0 }
  $rightsBox.Checked = $course.rightsVerified -eq $true
  $publishedBox.Checked = $course.published -eq $true
  $saleBox.Checked = $course.saleEnabled -eq $true
  $idLabel.Text = "Mã: $($script:EditingCourseId) (không đổi)"
  $saveButton.Text = "LƯU THAY ĐỔI"
}

$newButton.Add_Click({ Clear-Editor })
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
    $streamAvailable = $streamBox.SelectedIndex -eq 1
    $editingCourse = if ($script:EditingCourseId) {
      @($script:Catalog.courses) | Where-Object { [string]$_.id -eq $script:EditingCourseId } | Select-Object -First 1
    } else { $null }
    $hasPublishedLesson = $null -ne $editingCourse -and @($editingCourse.lessons | Where-Object { $_.published -eq $true }).Count -gt 0
    $errorMessage = Get-CourseValidationError $title $description $price $planTier $rightsBox.Checked $publishedBox.Checked $saleBox.Checked $streamAvailable $hasPublishedLesson $imageUrl $previewUrl
    if ($errorMessage) {
      [Windows.Forms.MessageBox]::Show($errorMessage, "Dữ liệu chưa hợp lệ", "OK", "Warning") | Out-Null
      return
    }

    $current = Get-CatalogSnapshot
    if ($current.Fingerprint -ne $script:CatalogFingerprint) {
      Refresh-CourseList
      Clear-Editor
      [Windows.Forms.MessageBox]::Show("catalog.json vừa được thay đổi ở nơi khác. Danh sách đã tải lại; hãy nhập lại để tránh ghi đè dữ liệu.", "Catalog đã thay đổi", "OK", "Warning") | Out-Null
      return
    }

    $workingCatalog = $current.Catalog
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
    Set-CourseProperty $course "streamAvailable" ([bool]$streamAvailable)
    Set-CourseProperty $course "saleEnabled" ([bool]$saleBox.Checked)
    Set-CourseProperty $course "forumVisible" $true
    Set-CourseProperty $course "rightsVerified" ([bool]$rightsBox.Checked)
    Set-CourseProperty $course "published" ([bool]$publishedBox.Checked)

    Save-CatalogAtomically $workingCatalog
    Refresh-CourseList $courseId
    Load-CourseIntoEditor $courseId
    $statusLabel.Text = "Đã cập nhật catalog trên web; chưa đăng Discord."
    $statusLabel.ForeColor = $success
    Write-Log "Đã lưu '$title' ($courseId) vào catalog web. Chưa đăng lên Discord."
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
  $courseGrid.Enabled = $true
  $editor.Enabled = $true
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
  $answer = [Windows.Forms.MessageBox]::Show(
    "Chỉ dữ liệu đã lưu trong catalog được dùng. Đăng/cập nhật tất cả khóa forumVisible lên kênh Discord ngay bây giờ?",
    "Xác nhận đồng bộ Discord",
    "YesNo",
    "Question"
  )
  if ($answer -ne [Windows.Forms.DialogResult]::Yes) { return }

  try {
    $script:SyncRunning = $true
    $syncButton.Enabled = $false
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
    $courseGrid.Enabled = $true
    $editor.Enabled = $true
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
    if ($split.Top -lt $header.Bottom -or $split.Bottom -gt $outputGroup.Top) { throw "Khu vực nội dung chồng lên header hoặc nhật ký." }
    if ($outputBox.Top -lt $syncBar.Bottom) { throw "Nhật ký chồng lên thanh đồng bộ." }
    if ($split.Panel2.ClientSize.Width -lt 480) { throw "Khung nhập khóa học quá hẹp: $($split.Panel2.ClientSize.Width)px." }
    $priceLabel = $editor.Controls | Where-Object { $_ -is [Windows.Forms.Label] -and $_.Text -eq "Giá bán (VNĐ)" } | Select-Object -First 1
    $planLabel = $editor.Controls | Where-Object { $_ -is [Windows.Forms.Label] -and $_.Text -eq "Thuộc gói" } | Select-Object -First 1
    if ($priceLabel.Bounds.IntersectsWith($planLabel.Bounds)) { throw "Nhãn Giá bán và Thuộc gói đang chồng nhau." }
    if ($saveButton.Bottom -gt $editor.ClientSize.Height) { throw "Nút lưu nằm ngoài khung nhập khóa học." }
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

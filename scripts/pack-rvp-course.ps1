[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$SourceFolder,
  [Parameter(Mandatory = $true)][string]$CourseId,
  [Parameter(Mandatory = $true)][string]$Title,
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [Parameter(Mandatory = $true)][string]$DownloadUrl,
  [string]$ApiBase = "https://learn.nixart.io.vn",
  [string]$PlayerExe = $env:NIXART_PLAYER_EXE
)

$ErrorActionPreference = "Stop"
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$catalogPath = Join-Path $repoRoot "content\catalog.json"
if (-not $PlayerExe) { $PlayerExe = "E:\Revoice\str to dub\windows_player\bin\Release\net10.0-windows\NixartPlayer.exe" }
if (-not [IO.File]::Exists($PlayerExe)) { throw "Không tìm thấy NixartPlayer.exe: $PlayerExe" }
if (-not [IO.Directory]::Exists($SourceFolder)) { throw "Không tìm thấy folder: $SourceFolder" }
if ($CourseId -cnotmatch "^[a-z0-9][a-z0-9_-]{1,63}$") { throw "Mã khóa học không hợp lệ." }
$downloadUri = $null
if (-not [Uri]::TryCreate($DownloadUrl, [UriKind]::Absolute, [ref]$downloadUri) -or $downloadUri.Scheme -ne "https") {
  throw "Link tải .rvp phải là HTTPS."
}
$adminToken = [string]$env:RVP_ADMIN_TOKEN
if ($adminToken.Length -lt 32) { throw "Thiếu RVP_ADMIN_TOKEN (tối thiểu 32 ký tự)." }

$keyFile = Join-Path ([IO.Path]::GetTempPath()) ("nixart-rvp-{0}.json" -f [Guid]::NewGuid().ToString("N"))
try {
  & $PlayerExe --pack-course $SourceFolder $CourseId $OutputPath --title $Title --key-out $keyFile
  if ($LASTEXITCODE -ne 0 -or -not [IO.File]::Exists($keyFile)) { throw "Player đóng gói RVP thất bại." }
  $package = Get-Content -LiteralPath $keyFile -Raw -Encoding UTF8 | ConvertFrom-Json
  $body = @{
    course_id = $CourseId
    title = $Title
    download_url = $DownloadUrl
    course_key = [string]$package.course_key
    package_sha256 = [string]$package.package_sha256
  } | ConvertTo-Json
  $headers = @{ Authorization = "Bearer $adminToken" }
  Invoke-RestMethod -Method Post -Uri ($ApiBase.TrimEnd("/") + "/api/player/admin-course") `
    -Headers $headers -ContentType "application/json; charset=utf-8" -Body $body | Out-Null

  $catalogBytes = [IO.File]::ReadAllBytes($catalogPath)
  $catalog = [Text.Encoding]::UTF8.GetString($catalogBytes).TrimStart([char]0xFEFF) | ConvertFrom-Json
  $course = @($catalog.courses) | Where-Object { [string]$_.id -ceq $CourseId } | Select-Object -First 1
  if ($null -eq $course) { throw "Server đã nhận khóa nhưng catalog không có course '$CourseId'. Hãy tạo khóa học trước rồi chạy lại." }
  foreach ($item in @(
    @{ Name = "deliveryMode"; Value = "RVP_DEVICE" },
    @{ Name = "streamAvailable"; Value = $false },
    @{ Name = "rvpAvailable"; Value = $true }
  )) {
    if ($null -eq $course.PSObject.Properties[$item.Name]) {
      $course | Add-Member -MemberType NoteProperty -Name $item.Name -Value $item.Value
    } else { $course.($item.Name) = $item.Value }
  }
  $json = ($catalog | ConvertTo-Json -Depth 100) + [Environment]::NewLine
  $utf8 = New-Object Text.UTF8Encoding($false)
  $temporary = "$catalogPath.rvp.tmp"
  [IO.File]::WriteAllText($temporary, $json, $utf8)
  [IO.File]::Replace($temporary, $catalogPath, "$catalogPath.rvp-backup", $true)
  [pscustomobject]@{
    ok = $true; course_id = $CourseId; output = [IO.Path]::GetFullPath($OutputPath)
    package_sha256 = [string]$package.package_sha256; download_url = $DownloadUrl
  } | ConvertTo-Json -Compress
} finally {
  if ([IO.File]::Exists($keyFile)) { [IO.File]::Delete($keyFile) }
}

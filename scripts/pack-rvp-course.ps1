[CmdletBinding()]
param(
  [string]$SourceFolder,
  [Parameter(Mandatory = $true)][string]$CourseId,
  [Parameter(Mandatory = $true)][string]$Title,
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [string]$DownloadUrl,
  [string]$DriveFolder,
  [string]$ExistingPackage,
  [string]$KeyJson,
  [string]$ApiBase = "https://nixart-web.onrender.com",
  [string]$PlayerExe = $env:NIXART_PLAYER_EXE
)

$ErrorActionPreference = "Stop"
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$catalogPath = Join-Path $repoRoot "content\catalog.json"
if (-not $PlayerExe) { $PlayerExe = "E:\Revoice\str to dub\windows_player\bin\Release\net10.0-windows\NixartPlayer.exe" }
if (-not $ExistingPackage -and -not [IO.File]::Exists($PlayerExe)) { throw "NixartPlayer.exe not found: $PlayerExe" }
if ($CourseId -cnotmatch "^[a-z0-9][a-z0-9_-]{1,63}$") { throw "Invalid course ID." }
if ($ExistingPackage) {
  if (-not [IO.File]::Exists($ExistingPackage)) { throw "Existing RVP package not found: $ExistingPackage" }
  if (-not $KeyJson -or -not [IO.File]::Exists($KeyJson)) { throw "Key JSON from ReVoice is required." }
} elseif (-not [IO.Directory]::Exists($SourceFolder)) { throw "Source folder not found: $SourceFolder" }
$downloadUri = $null
if (-not $DownloadUrl) {
  $folderId = if ($DriveFolder -match '^[A-Za-z0-9_-]{10,200}$') { $DriveFolder } elseif ($DriveFolder -match '/folders/([A-Za-z0-9_-]{10,200})') { $matches[1] } else { "" }
  if (-not $folderId) { throw "A Google Drive folder link or ID is required." }
}
$adminToken = [string]$env:RVP_ADMIN_TOKEN
if ($adminToken.Length -lt 32) { throw "RVP_ADMIN_TOKEN is missing or shorter than 32 characters." }

$keyFile = Join-Path ([IO.Path]::GetTempPath()) ("nixart-rvp-{0}.json" -f [Guid]::NewGuid().ToString("N"))
try {
  $packagePath = if ($ExistingPackage) { [IO.Path]::GetFullPath($ExistingPackage) } else { [IO.Path]::GetFullPath($OutputPath) }
  if ($ExistingPackage) {
    $package = Get-Content -LiteralPath $KeyJson -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([string]$package.course_id -cne $CourseId) { throw "Key JSON không thuộc course $CourseId." }
    $actualHash = (Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne ([string]$package.package_sha256).Trim().ToLowerInvariant()) { throw "SHA-256 của RVP không khớp key JSON." }
  } else {
    & $PlayerExe --pack-course $SourceFolder $CourseId $OutputPath --title $Title --key-out $keyFile
    if ($LASTEXITCODE -ne 0 -or -not [IO.File]::Exists($keyFile)) { throw "RVP packaging failed." }
    $package = Get-Content -LiteralPath $keyFile -Raw -Encoding UTF8 | ConvertFrom-Json
  }
  if (-not $DownloadUrl) {
    $uploader = Join-Path $PSScriptRoot "upload-rvp-drive.js"
    $envPath = Join-Path $repoRoot ".env"
    $DownloadUrl = (& node "--env-file-if-exists=$envPath" $uploader $packagePath $folderId).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $DownloadUrl) { throw "RVP upload to Google Drive failed." }
  }
  if (-not [Uri]::TryCreate($DownloadUrl, [UriKind]::Absolute, [ref]$downloadUri) -or $downloadUri.Scheme -ne "https") {
    throw "RVP download URL must use HTTPS."
  }
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
  if ($null -eq $course) { throw "Server accepted the key but catalog has no course '$CourseId'. Create the course first, then retry." }
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
    ok = $true; course_id = $CourseId; output = $packagePath
    package_sha256 = [string]$package.package_sha256; download_url = $DownloadUrl
  } | ConvertTo-Json -Compress
} finally {
  if ([IO.File]::Exists($keyFile)) { [IO.File]::Delete($keyFile) }
}

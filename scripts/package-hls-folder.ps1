[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$InputFolder,
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-z0-9][a-z0-9_-]{0,79}$')][string]$CourseId,
  [string]$CourseTitle = "",
  [ValidateRange(360, 2160)][int]$Height = 1080,
  [ValidateRange(2, 10)][int]$SegmentSeconds = 6,
  [ValidateRange(16, 30)][int]$Crf = 22,
  [ValidateRange(0, 999)][int]$Limit = 0,
  [switch]$Recurse,
  [switch]$StreamCopy,
  [switch]$Force,
  [switch]$Plan
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$catalogPath = Join-Path $repoRoot 'content\catalog.json'
$singlePackager = Join-Path $PSScriptRoot 'package-hls.ps1'
$mediaCourseRoot = Join-Path $repoRoot "media\$CourseId"
$manifestPath = Join-Path $mediaCourseRoot 'source-manifest.json'
$folder = (Resolve-Path -LiteralPath $InputFolder).Path
$videoExtensions = @('.mp4', '.mov', '.mkv', '.m4v')
$videos = @(Get-ChildItem -LiteralPath $folder -File -Recurse:$Recurse | Where-Object { $videoExtensions -contains $_.Extension.ToLowerInvariant() } | Sort-Object FullName)
if ($Limit -gt 0) { $videos = @($videos | Select-Object -First $Limit) }

if ($videos.Count -eq 0) { throw "No videos found in $folder" }
if (-not (Get-Command ffprobe -ErrorAction SilentlyContinue)) { throw 'ffprobe was not found in PATH.' }

function Get-DurationLabel {
  param([string]$Path)

  $secondsText = (& ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 -- $Path).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $secondsText) { throw "Could not read duration: $Path" }
  $totalSeconds = [int][Math]::Round([double]::Parse($secondsText, [Globalization.CultureInfo]::InvariantCulture))
  $hours = [Math]::Floor($totalSeconds / 3600)
  $minutes = [Math]::Floor(($totalSeconds % 3600) / 60)
  $seconds = $totalSeconds % 60
  if ($hours -gt 0) { return ('{0}:{1:00}:{2:00}' -f $hours, $minutes, $seconds) }
  '{0}:{1:00}' -f $minutes, $seconds
}

function Test-HlsPlaylist {
  param([string]$Path)

  if (-not [IO.File]::Exists($Path)) { return $false }
  $lines = [IO.File]::ReadAllLines($Path)
  if ($lines -notcontains '#EXT-X-ENDLIST') { return $false }
  $segments = @($lines | Where-Object { $_ -and -not $_.StartsWith('#') })
  if ($segments.Count -eq 0) { return $false }
  $directory = [IO.Path]::GetDirectoryName($Path)
  foreach ($segment in $segments) {
    if ($segment -cnotmatch '^seg_[A-Za-z0-9_]+_[0-9]{5}\.ts$' -or -not [IO.File]::Exists((Join-Path $directory $segment))) {
      return $false
    }
  }
  $true
}

function Set-ObjectProperty {
  param($Object, [string]$Name, $Value)

  if ($null -eq $Object.PSObject.Properties[$Name]) {
    $Object | Add-Member -MemberType NoteProperty -Name $Name -Value $Value
  } else {
    $Object.$Name = $Value
  }
}

function Get-SourceIdentity {
  param($Lesson)

  $file = Get-Item -LiteralPath $Lesson.source
  [pscustomobject][ordered]@{
    id = [string]$Lesson.id
    source = $file.FullName
    length = [long]$file.Length
    lastWriteTimeUtc = $file.LastWriteTimeUtc.ToString('O')
    sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
    streamCopy = [bool]$StreamCopy
    height = $Height
    segmentSeconds = $SegmentSeconds
    crf = $Crf
  }
}

function Get-SourceManifest {
  if (-not [IO.File]::Exists($manifestPath)) {
    return [pscustomobject][ordered]@{ version = 1; lessons = @() }
  }
  try { $manifest = [IO.File]::ReadAllText($manifestPath, [Text.Encoding]::UTF8) | ConvertFrom-Json } catch {
    throw "Invalid HLS source manifest: $($_.Exception.Message)"
  }
  if ($manifest.version -ne 1 -or $null -eq $manifest.PSObject.Properties['lessons']) { throw 'Unsupported HLS source manifest.' }
  $manifest
}

function Test-SourceIdentity {
  param($Expected, $Actual)

  $null -ne $Expected -and
    [string]$Expected.id -ceq [string]$Actual.id -and
    [string]$Expected.source -ieq [string]$Actual.source -and
    [long]$Expected.length -eq [long]$Actual.length -and
    [string]$Expected.lastWriteTimeUtc -ceq [string]$Actual.lastWriteTimeUtc -and
    [string]$Expected.sha256 -ceq [string]$Actual.sha256 -and
    [bool]$Expected.streamCopy -eq [bool]$Actual.streamCopy -and
    [int]$Expected.height -eq [int]$Actual.height -and
    [int]$Expected.segmentSeconds -eq [int]$Actual.segmentSeconds -and
    [int]$Expected.crf -eq [int]$Actual.crf
}

function Save-SourceManifest {
  param($Manifest)

  [IO.Directory]::CreateDirectory($mediaCourseRoot) | Out-Null
  $temporary = Join-Path $mediaCourseRoot ('.source-manifest.{0}.tmp' -f [Guid]::NewGuid().ToString('N'))
  $backup = Join-Path $mediaCourseRoot 'source-manifest.previous.json'
  $utf8 = New-Object Text.UTF8Encoding($false)
  try {
    [IO.File]::WriteAllText($temporary, ($Manifest | ConvertTo-Json -Depth 10) + [Environment]::NewLine, $utf8)
    if ([IO.File]::Exists($manifestPath)) {
      [IO.File]::Replace($temporary, $manifestPath, $backup, $true)
    } else {
      [IO.File]::Move($temporary, $manifestPath)
    }
  } finally {
    if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
  }
}

function Get-CatalogSnapshot {
  $bytes = [IO.File]::ReadAllBytes($catalogPath)
  $text = [Text.Encoding]::UTF8.GetString($bytes).TrimStart([char]0xFEFF)
  try { $catalog = $text | ConvertFrom-Json } catch { throw "Invalid catalog.json: $($_.Exception.Message)" }
  if ($null -eq $catalog.PSObject.Properties['courses']) { throw 'catalog.json is missing courses.' }
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $hash = [Convert]::ToBase64String($sha.ComputeHash($bytes)) } finally { $sha.Dispose() }
  [pscustomobject]@{ Catalog = $catalog; Fingerprint = $hash }
}

function Save-CatalogAtomically {
  param($Catalog, [string]$ExpectedFingerprint)

  if ((Get-CatalogSnapshot).Fingerprint -ne $ExpectedFingerprint) {
    throw 'The catalog changed elsewhere. HLS is ready, but lessons were not written.'
  }
  $temporary = Join-Path ([IO.Path]::GetDirectoryName($catalogPath)) ('.catalog.{0}.tmp' -f [Guid]::NewGuid().ToString('N'))
  $backup = "$catalogPath.hls-backup"
  $utf8 = New-Object Text.UTF8Encoding($false)
  $bytes = $utf8.GetBytes(($Catalog | ConvertTo-Json -Depth 100) + [Environment]::NewLine)
  try {
    $stream = New-Object IO.FileStream($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough)
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    [IO.File]::Replace($temporary, $catalogPath, $backup, $true)
  } finally {
    if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
  }
}

$vietnameseLabel = -join @([char]0x54, [char]0x69, [char]0x1EBF, [char]0x6E, [char]0x67, [char]0x20, [char]0x56, [char]0x69, [char]0x1EC7, [char]0x74)
$lessons = @()
for ($index = 0; $index -lt $videos.Count; $index++) {
  $video = $videos[$index]
  $sourceBase = [IO.Path]::GetFileNameWithoutExtension($video.Name).Trim()
  $isVietnameseDub = $sourceBase -match '(?i)_vi_dubbed$'
  $cleanTitle = ($sourceBase -replace '(?i)_vi_dubbed$', '' -replace '_', ' ').Trim()
  if (-not $cleanTitle -or $cleanTitle.Length -gt 240 -or $cleanTitle -match '[\x00-\x1F\x7F]') { throw "Invalid lesson title: $($video.Name)" }
  $lessons += [pscustomobject][ordered]@{
    id = ('lesson-{0:D2}' -f ($index + 1))
    title = $(if ($isVietnameseDub) { "$cleanTitle - $vietnameseLabel" } else { $cleanTitle })
    duration = Get-DurationLabel $video.FullName
    published = $true
    source = $video.FullName
  }
}

if ($Plan) {
  $lessons | Select-Object id, title, duration, source | Format-Table -AutoSize
  return
}

$generatedIds = @($lessons | ForEach-Object { [string]$_.id })
$preflight = Get-CatalogSnapshot
$preflightMatches = @($preflight.Catalog.courses | Where-Object { [string]$_.id -ceq $CourseId })
if ($preflightMatches.Count -gt 1) { throw "Duplicate course ID in catalog: $CourseId" }
if ($preflightMatches.Count -eq 1) {
  $unexpected = @($preflightMatches[0].lessons | Where-Object { $generatedIds -notcontains [string]$_.id })
  $isDraft = $preflightMatches[0].published -ne $true -and $preflightMatches[0].saleEnabled -ne $true -and $preflightMatches[0].forumVisible -ne $true `
    -and $preflightMatches[0].rightsVerified -ne $true -and [decimal]$preflightMatches[0].price -eq 0
  $generatedExtrasOnly = @($unexpected | Where-Object { [string]$_.id -cnotmatch '^lesson-[0-9]{2,3}$' }).Count -eq 0
  if ($unexpected.Count -gt 0 -and ($Limit -eq 0 -or -not $isDraft -or -not $generatedExtrasOnly)) {
    throw "Course $CourseId has protected lessons; use a new draft course ID."
  }
}

$manifest = Get-SourceManifest
$identities = @{}
foreach ($lesson in $lessons) { $identities[[string]$lesson.id] = Get-SourceIdentity $lesson }

for ($index = 0; $index -lt $lessons.Count; $index++) {
  $lesson = $lessons[$index]
  $playlist = Join-Path $repoRoot "media\$CourseId\$($lesson.id)\index.m3u8"
  $identity = $identities[[string]$lesson.id]
  $savedIdentity = @($manifest.lessons | Where-Object { [string]$_.id -ceq [string]$lesson.id }) | Select-Object -First 1
  Write-Host ("[{0}/{1}] {2}" -f ($index + 1), $lessons.Count, $lesson.title)
  if (-not $Force -and (Test-HlsPlaylist $playlist) -and (Test-SourceIdentity $savedIdentity $identity)) {
    Write-Host "Skip complete playlist: $playlist"
    continue
  }
  $packagerArguments = @{
    InputFile = $lesson.source
    CourseId = $CourseId
    LessonId = $lesson.id
    Height = $Height
    SegmentSeconds = $SegmentSeconds
    Crf = $Crf
    StreamCopy = $StreamCopy
  }
  & $singlePackager @packagerArguments
  if (-not (Test-HlsPlaylist $playlist)) { throw "Incomplete playlist after packaging: $playlist" }
  $manifest.lessons = @($manifest.lessons | Where-Object { [string]$_.id -cne [string]$lesson.id }) + $identity
  Save-SourceManifest $manifest
}

foreach ($lesson in $lessons) {
  $playlist = Join-Path $repoRoot "media\$CourseId\$($lesson.id)\index.m3u8"
  if (-not (Test-HlsPlaylist $playlist)) { throw "Incomplete playlist after packaging: $playlist" }
  $lesson.PSObject.Properties.Remove('source')
}

$snapshot = Get-CatalogSnapshot
$catalog = $snapshot.Catalog
$matches = @($catalog.courses | Where-Object { [string]$_.id -ceq $CourseId })
if ($matches.Count -gt 1) { throw "Duplicate course ID in catalog: $CourseId" }
if ($matches.Count -eq 0) {
  $title = if ($CourseTitle.Trim()) { $CourseTitle.Trim() } else { [IO.Path]::GetFileName($folder.TrimEnd('\')) }
  if (-not $title -or $title.Length -gt 100 -or $title -match '[\x00-\x1F\x7F]') { throw 'Course title must contain 1-100 safe characters.' }
  $course = [pscustomobject][ordered]@{
    id = $CourseId
    title = $title
    description = ''
    imageUrl = ''
    previewUrl = ''
    price = 0
    planTier = 'full'
    deliveryMode = 'STREAM'
    streamAvailable = $true
    saleEnabled = $false
    published = $false
    forumVisible = $false
    rightsVerified = $false
    lessons = @()
  }
  $catalog.courses = @($catalog.courses) + $course
  Write-Host "Created draft course: $CourseId"
} else {
  $course = $matches[0]
  $unexpected = @($course.lessons | Where-Object { $generatedIds -notcontains [string]$_.id })
  $isDraft = $course.published -ne $true -and $course.saleEnabled -ne $true -and $course.forumVisible -ne $true `
    -and $course.rightsVerified -ne $true -and [decimal]$course.price -eq 0
  $generatedExtrasOnly = @($unexpected | Where-Object { [string]$_.id -cnotmatch '^lesson-[0-9]{2,3}$' }).Count -eq 0
  if ($unexpected.Count -gt 0 -and ($Limit -eq 0 -or -not $isDraft -or -not $generatedExtrasOnly)) {
    throw "Course $CourseId changed and now has protected lessons; catalog was not updated."
  }
}

Set-ObjectProperty $course 'deliveryMode' 'STREAM'
Set-ObjectProperty $course 'streamAvailable' $true
Set-ObjectProperty $course 'lessons' @($lessons)
Save-CatalogAtomically $catalog $snapshot.Fingerprint

Write-Host "Completed $($lessons.Count) HLS lessons for $CourseId."
Write-Host 'Open Course Manager to add pricing, artwork, rights verification, and publish the course.'

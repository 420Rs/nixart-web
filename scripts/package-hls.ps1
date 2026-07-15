param(
  [Parameter(Mandatory = $true)][string]$InputFile,
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-z0-9][a-z0-9_-]{0,79}$')][string]$CourseId,
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-z0-9][a-z0-9_-]{0,79}$')][string]$LessonId,
  [ValidateRange(360, 2160)][int]$Height = 1080,
  [ValidateRange(2, 10)][int]$SegmentSeconds = 6,
  [ValidateRange(16, 30)][int]$Crf = 22,
  [switch]$StreamCopy
)

$ErrorActionPreference = 'Stop'
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
  throw 'ffmpeg was not found in PATH.'
}

$source = (Resolve-Path -LiteralPath $InputFile).Path
if ($StreamCopy) {
  if (-not (Get-Command ffprobe -ErrorAction SilentlyContinue)) { throw 'ffprobe was not found in PATH.' }
  $probe = (& ffprobe -v error -show_entries stream=codec_type,codec_name,profile,pix_fmt -of json -- $source) | ConvertFrom-Json
  $videoStream = $probe.streams | Where-Object { $_.codec_type -eq 'video' } | Select-Object -First 1
  $audioStream = $probe.streams | Where-Object { $_.codec_type -eq 'audio' } | Select-Object -First 1
  $videoCodec = [string]$videoStream.codec_name
  $audioCodec = [string]$audioStream.codec_name
  $safeProfiles = @('Baseline', 'Constrained Baseline', 'Main', 'High')
  if ($videoCodec -ne 'h264' -or [string]$videoStream.pix_fmt -ne 'yuv420p' -or $safeProfiles -notcontains [string]$videoStream.profile `
      -or ($audioCodec -and ($audioCodec -ne 'aac' -or [string]$audioStream.profile -ne 'LC'))) {
    throw "StreamCopy requires browser-safe H.264 yuv420p and optional AAC-LC; found $videoCodec/$($videoStream.profile)/$($videoStream.pix_fmt) + $audioCodec/$($audioStream.profile)"
  }
}
$repoRoot = Split-Path -Parent $PSScriptRoot
$output = Join-Path $repoRoot "media\$CourseId\$LessonId"
New-Item -ItemType Directory -Force -Path $output | Out-Null
$revision = "$(Get-Date -Format 'yyyyMMddHHmmss')_$([guid]::NewGuid().ToString('N').Substring(0, 8))"
$nextPlaylist = "index_$revision.m3u8"
$livePlaylist = Join-Path $output 'index.m3u8'
$backupPlaylist = Join-Path $output 'index.previous.m3u8'

Push-Location $output
try {
  $ErrorActionPreference = 'Continue'
  if ($StreamCopy) {
    & ffmpeg -hide_banner -loglevel warning -y -i $source `
      -map 0:v:0 -map '0:a:0?' -c copy `
      -hls_time $SegmentSeconds -hls_list_size 0 -hls_playlist_type vod `
      -hls_flags independent_segments `
      -hls_segment_filename "seg_${revision}_%05d.ts" $nextPlaylist
  } else {
    & ffmpeg -hide_banner -loglevel warning -y -i $source `
      -map 0:v:0 -map '0:a:0?' `
      -vf "scale=-2:$Height" `
      -c:v libx264 -preset medium -crf $Crf -pix_fmt yuv420p `
      -c:a aac -b:a 128k -ac 2 `
      -force_key_frames "expr:gte(t,n_forced*$SegmentSeconds)" `
      -hls_time $SegmentSeconds -hls_list_size 0 -hls_playlist_type vod `
      -hls_flags independent_segments `
      -hls_segment_filename "seg_${revision}_%05d.ts" $nextPlaylist
  }
  $ffmpegExitCode = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  if ($ffmpegExitCode -ne 0) { throw "FFmpeg exited with code $ffmpegExitCode" }
}
finally {
  $ErrorActionPreference = 'Stop'
  Pop-Location
}

$nextPlaylistPath = Join-Path $output $nextPlaylist
if (Test-Path -LiteralPath $livePlaylist) {
  [System.IO.File]::Replace($nextPlaylistPath, $livePlaylist, $backupPlaylist, $true)
  Remove-Item -LiteralPath $backupPlaylist -Force
}
else {
  Move-Item -LiteralPath $nextPlaylistPath -Destination $livePlaylist
}

Write-Host "Created HLS: $output\index.m3u8"
Write-Host 'Old revision segments are kept so active viewers are not interrupted.'

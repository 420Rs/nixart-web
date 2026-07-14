param(
  [Parameter(Mandatory = $true)][string]$InputFile,
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-z0-9][a-z0-9_-]{0,79}$')][string]$CourseId,
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-z0-9][a-z0-9_-]{0,79}$')][string]$LessonId,
  [ValidateRange(360, 2160)][int]$Height = 720,
  [ValidateRange(2, 10)][int]$SegmentSeconds = 6,
  [ValidateRange(16, 30)][int]$Crf = 22
)

$ErrorActionPreference = 'Stop'
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
  throw 'Không tìm thấy ffmpeg trong PATH.'
}

$source = (Resolve-Path -LiteralPath $InputFile).Path
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
  & ffmpeg -hide_banner -y -i $source `
    -map 0:v:0 -map '0:a:0?' `
    -vf "scale=-2:$Height" `
    -c:v libx264 -preset medium -crf $Crf -pix_fmt yuv420p `
    -c:a aac -b:a 128k -ac 2 `
    -force_key_frames "expr:gte(t,n_forced*$SegmentSeconds)" `
    -hls_time $SegmentSeconds -hls_list_size 0 -hls_playlist_type vod `
    -hls_flags independent_segments `
    -hls_segment_filename "seg_${revision}_%05d.ts" $nextPlaylist
  $ffmpegExitCode = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  if ($ffmpegExitCode -ne 0) { throw "FFmpeg kết thúc với mã $ffmpegExitCode" }
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

Write-Host "Đã tạo HLS: $output\index.m3u8"
Write-Host 'Các segment phiên bản cũ được giữ lại để người đang xem không bị gián đoạn.'

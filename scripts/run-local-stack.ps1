$ErrorActionPreference = "Stop"

$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$cloudflared = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
$tunnelConfig = Join-Path $HOME ".cloudflared\config.yml"

function Start-NixartNode {
  Start-Process -FilePath "node" `
    -ArgumentList "--env-file-if-exists=.env", "server.js" `
    -WorkingDirectory $repo `
    -WindowStyle Hidden `
    -PassThru
}

function Start-NixartTunnel {
  Start-Process -FilePath $cloudflared `
    -ArgumentList "tunnel", "--config", $tunnelConfig, "run", "nixart-home" `
    -WindowStyle Hidden `
    -PassThru
}

$nodeProcess = Start-NixartNode
$tunnelProcess = Start-NixartTunnel

while ($true) {
  Start-Sleep -Seconds 5
  if ($nodeProcess.HasExited) { $nodeProcess = Start-NixartNode }
  if ($tunnelProcess.HasExited) { $tunnelProcess = Start-NixartTunnel }
}

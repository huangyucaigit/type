param(
    [Parameter(Mandatory = $true)]
    [string]$ReleaseId,
    [string]$Server = '47.106.182.159',
    [string]$IdentityFile = "$env:USERPROFILE\.ssh\codex_linux",
    [switch]$UpdateProxyRoutes
)

$ErrorActionPreference = 'Stop'
if ($Server -notmatch '^[a-zA-Z0-9.-]+$') { throw 'Invalid server address.' }
if ($ReleaseId -notmatch '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$') { throw 'Invalid backup release identifier.' }
$sshOptions = @('-i', $IdentityFile, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'StrictHostKeyChecking=yes')
$target = "root@$Server"
$operationId = 'rollback-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$arguments = "rollback --release-id $operationId --snapshot-id $ReleaseId"
if ($UpdateProxyRoutes) { $arguments += ' --allow-proxy-update' }
$helper = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'remote_release.py') -Raw
Write-Host "Rollback operation: $operationId; selected backup: $ReleaseId"
$response = $helper | & ssh @sshOptions $target "tr -d '\r' | python3 - $arguments"
if ($LASTEXITCODE -ne 0) { throw 'Rollback failed; inspect the private .releases record on the server.' }
$result = $response | ConvertFrom-Json
Write-Host "Rollback status: $($result.status); previous state saved as: $($result.backupId)"

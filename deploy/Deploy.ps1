param(
    [string]$Server = '47.106.182.159',
    [string]$IdentityFile = "$env:USERPROFILE\.ssh\codex_linux",
    [switch]$UpdateSecrets,
    [switch]$UpdateProxyRoutes
)

$ErrorActionPreference = 'Stop'
if ($Server -notmatch '^[a-zA-Z0-9.-]+$') { throw 'Invalid server address.' }
$projectRoot = Split-Path -Parent $PSScriptRoot
$sshOptions = @('-i', $IdentityFile, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'StrictHostKeyChecking=yes')
$target = "root@$Server"

function Invoke-ReleaseTool([string]$Arguments) {
    $helper = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'remote_release.py') -Raw
    $result = $helper | & ssh @sshOptions $target "tr -d '\r' | python3 - $Arguments"
    if ($LASTEXITCODE -ne 0) { throw 'Remote release operation failed; inspect the private .releases record on the server.' }
    return $result
}
$items = @()
foreach ($file in Get-ChildItem -LiteralPath $projectRoot -File) {
    if ($file.Extension -notin @('.html', '.css', '.js', '.mjs') -and $file.Name -notin @('robots.txt', 'sitemap.xml')) { continue }
    if ($file.Name -notmatch '^[a-zA-Z0-9._-]+$') { throw 'Unsupported source filename.' }
    $items += [pscustomobject]@{ Source = $file.FullName; Target = "src/$($file.Name)"; Hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
}
foreach ($name in @('compose.yaml', 'nginx.conf')) {
    $file = Join-Path $PSScriptRoot $name
    $items += [pscustomobject]@{ Source = $file; Target = $name; Hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() }
}
foreach ($name in @('type.where.work.pem', 'type.where.work.key')) {
    $file = Join-Path (Join-Path $projectRoot 'tls') $name
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing TLS file: $name" }
    $items += [pscustomobject]@{ Source = $file; Target = "tls/$name"; Hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() }
}
$validateTls = @'
import fs from 'node:fs';
import path from 'node:path';
import { X509Certificate, createPrivateKey, createPublicKey } from 'node:crypto';
const root = process.argv[1];
const pem = fs.readFileSync(path.join(root, 'tls/type.where.work.pem'), 'utf8');
const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
if (!blocks.length) throw new Error('No TLS certificate found.');
const cert = new X509Certificate(blocks[0]);
const key = createPrivateKey(fs.readFileSync(path.join(root, 'tls/type.where.work.key')));
if (!cert.publicKey.export({ type: 'spki', format: 'der' }).equals(createPublicKey(key).export({ type: 'spki', format: 'der' }))) throw new Error('TLS certificate/private key mismatch.');
if (!cert.checkHost('type.where.work')) throw new Error('TLS certificate does not cover type.where.work.');
if (Date.now() < Date.parse(cert.validFrom) || Date.now() >= Date.parse(cert.validTo)) throw new Error('TLS certificate is not currently valid.');
for (let i = 0; i + 1 < blocks.length; i++) {
    if (!new X509Certificate(blocks[i]).verify(new X509Certificate(blocks[i + 1]).publicKey)) throw new Error('TLS certificate chain signature mismatch.');
}
console.log('TLS certificate, domain, validity and private key verified; private key hidden.');
'@
& node --input-type=module -e $validateTls $projectRoot
if ($LASTEXITCODE -ne 0) { throw 'TLS certificate validation failed.' }
$manifest = ConvertTo-Json -Compress -InputObject @($items | ForEach-Object { $_.Target })
$manifestBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($manifest))
$state = (Invoke-ReleaseTool "inspect --paths-base64 $manifestBase64") | ConvertFrom-Json
$proxyBytes = [IO.File]::ReadAllBytes((Join-Path $PSScriptRoot 'nginx.conf'))
$normalizedProxyBytes = [Text.Encoding]::UTF8.GetBytes([Text.Encoding]::UTF8.GetString($proxyBytes).Replace("`r`n", "`n"))
$hashAlgorithm = [Security.Cryptography.SHA256]::Create()
try { $proxyNormalizedHash = ([BitConverter]::ToString($hashAlgorithm.ComputeHash($normalizedProxyBytes))).Replace('-', '').ToLowerInvariant() }
finally { $hashAlgorithm.Dispose() }
$changed = @($items | Where-Object {
    $property = $state.hashes.PSObject.Properties[$_.Target]
    if ($_.Target -eq 'nginx.conf' -and $state.proxyNormalizedHash -eq $proxyNormalizedHash) { $false }
    else { -not $property -or $property.Value -ne $_.Hash }
})
$writeSecrets = $UpdateSecrets -or -not $state.hasConfig
$recreate = $writeSecrets -or @($changed | Where-Object { $_.Target -match '\.mjs$|^compose\.yaml$|^nginx\.conf$|^tls/' }).Count -gt 0
$deploymentId = 'release-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$commit = (& git -C $projectRoot rev-parse HEAD | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[a-f0-9]{40,64}$') { throw 'Cannot identify the deployment Git commit.' }
$worktreeChanges = (& git -C $projectRoot status --porcelain | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect local Git state.' }
if ($worktreeChanges) { $commit += '-dirty' }
$stagingRoot = Join-Path $projectRoot '.deploy'
$stage = Join-Path $stagingRoot "stage-$deploymentId"
$archive = Join-Path $stagingRoot "upload-$deploymentId.tar"
if ((Test-Path -LiteralPath $stagingRoot) -and ((Get-Item -LiteralPath $stagingRoot).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'The local deployment staging directory must not be a symbolic link or junction.'
}
if ((Test-Path -LiteralPath $stage) -or (Test-Path -LiteralPath $archive)) { throw 'Deployment staging identifier already exists.' }

try {
    New-Item -ItemType Directory -Force -Path $stage | Out-Null
    foreach ($item in $changed) {
        $destination = Join-Path $stage $item.Target
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
        Copy-Item -LiteralPath $item.Source -Destination $destination
        Write-Host "Changed: $($item.Target)"
    }
    if ($writeSecrets) {
        $secretFile = Join-Path $stage 'config/app.env'
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $secretFile) | Out-Null
        $secretScript = @'
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[1];
try { process.loadEnvFile(path.join(root, '.env')); }
catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot load local environment file.'); }
const { readConfig } = await import(pathToFileURL(path.join(root, 'translation-server.mjs')));
const config = readConfig();
const lines = [`DEEPSEEK_API_KEY=${JSON.stringify(config.key)}`, `DEEPSEEK_API_URL=${JSON.stringify(config.endpoint)}`];
const authKeys = ['ALIYUN_ACCESS_KEY_ID', 'ALIYUN_ACCESS_KEY_SECRET', 'ALIYUN_SMS_REGION_ID', 'ALIYUN_SMS_SIGN_NAME', 'ALIYUN_SMS_LOGIN_TEMPLATE_CODE', 'ALIYUN_SMS_REGISTER_TEMPLATE_CODE', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION', 'SES_FROM_EMAIL'];
for (const key of authKeys) {
    const value = process.env[key] || '';
    if (/[\r\n\0]/.test(value)) throw new Error('Private configuration contains unsupported characters.');
    lines.push(`${key}=${JSON.stringify(value)}`);
}
fs.writeFileSync(process.argv[2], `${lines.join('\n')}\n`, { mode: 0o600 });
console.log('Application configuration prepared; credentials hidden.');
'@
        & node --input-type=module -e $secretScript $projectRoot $secretFile
        if ($LASTEXITCODE -ne 0) { throw 'Could not prepare application configuration.' }
    }
    $uploadFiles = @($changed | ForEach-Object { [pscustomobject]@{ path = $_.Target; sha256 = $_.Hash } })
    if ($writeSecrets) {
        $uploadFiles += [pscustomobject]@{ path = 'config/app.env'; sha256 = (Get-FileHash -LiteralPath $secretFile -Algorithm SHA256).Hash.ToLowerInvariant() }
    }
    $uploadManifest = [ordered]@{ version = 1; files = $uploadFiles; baseline = $state.hashes }
    $manifestFile = Join-Path $stage 'manifest.json'
    [IO.File]::WriteAllText($manifestFile, (ConvertTo-Json -Depth 8 -InputObject $uploadManifest), (New-Object Text.UTF8Encoding($false)))
    & tar -cf $archive -C $stage .
    if ($LASTEXITCODE -ne 0) { throw 'Could not create deployment archive.' }
    & scp @sshOptions $archive "${target}:/opt/zijian/.incoming/upload-$deploymentId.tar"
    if ($LASTEXITCODE -ne 0) { throw 'Could not upload deployment archive.' }
    $arguments = "apply --release-id $deploymentId --commit $commit --upload /opt/zijian/.incoming/upload-$deploymentId.tar"
    if ($recreate) { $arguments += ' --recreate' }
    if ($UpdateProxyRoutes) { $arguments += ' --allow-proxy-update' }
    Write-Host "Release: $deploymentId; Git: $commit"
    $result = (Invoke-ReleaseTool $arguments) | ConvertFrom-Json
    Write-Host "Release status: $($result.status); rollback snapshot: $($result.backupId)"
    if (-not $result.hasPreviousRelease) { Write-Warning 'This deployment had no complete previous release; its snapshot cannot restore a running prior version.' }
} finally {
    if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
    if (Test-Path -LiteralPath $stage) {
        $resolvedStage = [IO.Path]::GetFullPath($stage)
        $resolvedStagingRoot = [IO.Path]::GetFullPath($stagingRoot).TrimEnd('\') + '\'
        if (-not $resolvedStage.StartsWith($resolvedStagingRoot, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Refusing to remove a directory outside the deployment staging area.'
        }
        Remove-Item -LiteralPath $resolvedStage -Recurse -Force
    }
}

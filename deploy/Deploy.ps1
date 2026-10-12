param(
    [string]$Server = '47.106.182.159',
    [string]$IdentityFile = "$env:USERPROFILE\.ssh\codex_linux",
    [switch]$UpdateSecrets
)

$ErrorActionPreference = 'Stop'
if ($Server -notmatch '^[a-zA-Z0-9.-]+$') { throw 'Invalid server address.' }
$projectRoot = Split-Path -Parent $PSScriptRoot
$sshOptions = @('-i', $IdentityFile, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'StrictHostKeyChecking=yes')
$target = "root@$Server"

function Invoke-RemotePython([string]$Code) {
    $result = $Code | & ssh @sshOptions $target "tr -d '\r' | python3 -"
    if ($LASTEXITCODE -ne 0) { throw 'Remote inspection failed.' }
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
$inspect = @"
import base64, hashlib, json
from pathlib import Path
root = Path('/opt/zijian')
root.mkdir(parents=True, exist_ok=True)
incoming = root / '.incoming'
incoming.mkdir(mode=0o700, exist_ok=True)
incoming.chmod(0o700)
paths = json.loads(base64.b64decode('$manifestBase64'))
hashes = {}
for name in paths:
    p = root / name
    if p.is_file():
        hashes[name] = hashlib.sha256(p.read_bytes()).hexdigest()
print(json.dumps({'hashes': hashes, 'hasConfig': (root / 'config/app.env').is_file()}))
"@
$state = (Invoke-RemotePython $inspect) | ConvertFrom-Json
$changed = @($items | Where-Object {
    $property = $state.hashes.PSObject.Properties[$_.Target]
    -not $property -or $property.Value -ne $_.Hash
})
$writeSecrets = $UpdateSecrets -or -not $state.hasConfig
$recreate = $writeSecrets -or @($changed | Where-Object { $_.Target -match '\.mjs$|^compose\.yaml$|^nginx\.conf$|^tls/' }).Count -gt 0
$deploymentId = [Guid]::NewGuid().ToString('N')
$stagingRoot = Join-Path $projectRoot '.deploy'
$stage = Join-Path $stagingRoot "stage-$deploymentId"
$archive = Join-Path $stagingRoot "upload-$deploymentId.tar"

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
fs.writeFileSync(process.argv[2], `DEEPSEEK_API_KEY=${JSON.stringify(config.key)}\nDEEPSEEK_API_URL=${JSON.stringify(config.endpoint)}\n`, { mode: 0o600 });
console.log(config.key ? 'DeepSeek configuration prepared; credential hidden.' : 'No DeepSeek credential configured; practice remains available.');
'@
        & node --input-type=module -e $secretScript $projectRoot $secretFile
        if ($LASTEXITCODE -ne 0) { throw 'Could not prepare application configuration.' }
    }
    if ($changed.Count -gt 0 -or $writeSecrets) {
        & tar -cf $archive -C $stage .
        if ($LASTEXITCODE -ne 0) { throw 'Could not create deployment archive.' }
        & scp @sshOptions $archive "${target}:/opt/zijian/.incoming/upload-$deploymentId.tar"
        if ($LASTEXITCODE -ne 0) { throw 'Could not upload deployment archive.' }
    } else {
        Write-Host 'No changed files to upload.'
    }
    $recreateFlag = if ($recreate) { '--force-recreate' } else { '' }
    $apply = @"
set -euo pipefail
cd /opt/zijian
umask 077
mkdir -p config tls data
chmod 700 config tls
chown 1000:1000 data
chmod 700 data
if [ -f .incoming/upload-$deploymentId.tar ]; then
  chmod 600 .incoming/upload-$deploymentId.tar
  tar -xf .incoming/upload-$deploymentId.tar
  rm -f .incoming/upload-$deploymentId.tar
fi
chmod 755 src
find src -maxdepth 1 -type f -exec chmod 644 {} +
chmod 700 config tls
chmod 600 config/app.env
chmod 600 tls/type.where.work.key
chmod 644 tls/type.where.work.pem
docker compose config --quiet
docker compose run --rm --no-deps -T web nginx -t </dev/null
docker compose up -d $recreateFlag --wait --wait-timeout 180
docker compose exec -T web nginx -t </dev/null
curl -fsS http://127.0.0.1/api/status
printf '\n'
curl --noproxy '*' --resolve type.where.work:443:127.0.0.1 -fsS https://type.where.work/api/status
printf '\n'
docker compose ps
"@
    $apply | & ssh @sshOptions $target "tr -d '\r' | bash -s"
    if ($LASTEXITCODE -ne 0) { throw 'Deployment did not pass service checks.' }
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

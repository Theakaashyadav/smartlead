$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$outputDirectory = Join-Path $workspace 'data'
$archivePath = Join-Path $outputDirectory 'smartlead-hostinger.zip'
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null

# Only deployment source is packaged. Private dotenv files and local sessions stay out.
$topLevel = @(
    'package.json', 'package-lock.json', 'next.config.ts', 'next-env.d.ts',
    'tsconfig.json', 'postcss.config.mjs', '.puppeteerrc.cjs', '.env.example',
    '.dockerignore', 'Dockerfile', 'Dockerfile.worker', 'docker-compose.yml',
    'docker-compose.hostinger.yml', 'docker-compose.worker.yml', 'README.md', 'AGENTS.md'
)
$files = @($topLevel | ForEach-Object { Get-Item -LiteralPath (Join-Path $workspace $_) })
foreach ($directory in @('src', 'prisma', 'scripts', 'deploy', 'public', 'docs')) {
    $sourceDirectory = Join-Path $workspace $directory
    if (Test-Path -LiteralPath $sourceDirectory) {
        $files += @(Get-ChildItem -LiteralPath $sourceDirectory -File -Recurse | Where-Object {
            $relative = $_.FullName.Substring($workspace.Length + 1).Replace('\', '/')
            -not $relative.StartsWith('src/generated/') -and
            $_.Name -notlike '.env*' -and $_.Extension -notin @('.log', '.db', '.zip')
        })
    }
}

Add-Type -AssemblyName System.IO.Compression
$stream = [System.IO.File]::Open($archivePath, [System.IO.FileMode]::Create)
try {
    $archive = New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Create, $true)
    try {
        foreach ($file in $files) {
            $relative = $file.FullName.Substring($workspace.Length + 1).Replace('\', '/')
            $entry = $archive.CreateEntry($relative, [System.IO.Compression.CompressionLevel]::Optimal)
            $entryStream = $entry.Open()
            $sourceStream = [System.IO.File]::OpenRead($file.FullName)
            try { $sourceStream.CopyTo($entryStream) }
            finally { $sourceStream.Dispose(); $entryStream.Dispose() }
        }
    } finally { $archive.Dispose() }
} finally { $stream.Dispose() }
Write-Output "Created $archivePath ($($files.Count) source files; no private environment files or local sessions)."

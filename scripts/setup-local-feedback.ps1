param([switch]$HostsOnly)

$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$localDomain = 'smartlead.example.com'
$hostsFile = Join-Path $env:WINDIR 'System32\drivers\etc\hosts'

try {
    Set-Location -LiteralPath $workspace
    $hostsText = [IO.File]::ReadAllText($hostsFile)
    $mappings = @($hostsText -split '\r?\n' | ForEach-Object {
        $parts = (($_ -split '#', 2)[0].Trim() -split '\s+')
        if ($parts.Count -gt 1 -and $parts[1..($parts.Count - 1)] -contains $localDomain) { $parts[0] }
    })
    if ($mappings | Where-Object { $_ -ne '127.0.0.1' }) { throw 'The local feedback hostname already has a different hosts mapping. No mapping was changed.' }
    if (-not $mappings) {
        $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
        if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
            if ($HostsOnly) { throw 'Administrator access is required to add the local feedback hostname.' }
            Write-Host 'Windows will request administrator access to map smartlead.example.com to 127.0.0.1 on this PC only.'
            $setupProcess = Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $PSCommandPath), '-HostsOnly') -PassThru
            $setupProcess.WaitForExit()
            if ($setupProcess.ExitCode -ne 0) { throw 'The local hostname was not enabled. Run Enable Local Feedback.cmd and approve the Windows administrator prompt.' }
        } else {
            $backupDirectory = Join-Path $workspace 'data\backups'
            New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
            [IO.File]::WriteAllText((Join-Path $backupDirectory ('hosts-before-local-feedback-' + [DateTime]::UtcNow.ToString('yyyyMMddHHmmssfff') + '.txt')), $hostsText)
            $separator = if ($hostsText.EndsWith("`n")) { '' } else { "`r`n" }
            [IO.File]::AppendAllText($hostsFile, $separator + "127.0.0.1`t$localDomain`t# SmartLead local feedback`r`n", (New-Object Text.UTF8Encoding($false)))
        }
    }
    if ($HostsOnly) { exit 0 }
    & (Get-Command node.exe -ErrorAction Stop).Source --import tsx (Join-Path $PSScriptRoot 'upgrade-feedback.ts') --allow-local --clickable
    if ($LASTEXITCODE -ne 0) { throw 'The local feedback configuration could not be saved.' }
    & (Get-Command node.exe -ErrorAction Stop).Source --import tsx (Join-Path $PSScriptRoot 'refresh-feedback-links.ts')
    if ($LASTEXITCODE -ne 0) { throw 'Queued feedback links could not be refreshed.' }
    Write-Host 'Local feedback hostname is ready. No hosting or tunnel is used. Previously sent messages keep their old links.'
    exit 0
} catch {
    Write-Host "Local feedback setup failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

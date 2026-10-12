param([switch]$NoBrowser, [switch]$EnableRemoteFeedback)

$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$loginUrl = 'http://127.0.0.1:3000/login'
$healthUrl = 'http://127.0.0.1:3000/api/health'

function Test-SmartLeadReady {
    try {
        $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
        return $health.data.status -eq 'ok' -and $health.data.mode -in @('demo', 'production')
    } catch {
        return $false
    }
}

try {
    Set-Location -LiteralPath $workspace
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $logDirectory = Join-Path $workspace 'data'
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
    if (-not (Test-SmartLeadReady)) {
        $node = (Get-Command node.exe -ErrorAction Stop).Source
        $nextCli = Join-Path $workspace 'node_modules\next\dist\bin\next'
        if (-not (Test-Path -LiteralPath $nextCli)) {
            throw 'Dependencies are missing. Run npm ci and npm run demo:setup in this folder first.'
        }
        if (-not (Test-Path -LiteralPath (Join-Path $workspace '.env'))) {
            throw 'Configuration is missing. Run npm run demo:setup in this folder first.'
        }
        if (-not (Test-Path -LiteralPath (Join-Path $workspace '.next\BUILD_ID'))) {
            Write-Host 'Preparing SmartLead for its first start...'
            & (Get-Command npm.cmd -ErrorAction Stop).Source run build
            if ($LASTEXITCODE -ne 0) { throw 'The build failed. Review the errors above.' }
        }

        $logDirectory = Join-Path $workspace 'data'
        New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
        $outputLog = Join-Path $logDirectory 'smartlead-server.log'
        $errorLog = Join-Path $logDirectory 'smartlead-server.error.log'
        $server = Start-Process -FilePath $node `
            -ArgumentList @(('"{0}"' -f $nextCli), 'start', '--hostname', '127.0.0.1', '--port', '3000') `
            -WorkingDirectory $workspace -WindowStyle Hidden `
            -RedirectStandardOutput $outputLog -RedirectStandardError $errorLog -PassThru
        Set-Content -LiteralPath (Join-Path $logDirectory 'smartlead-server.pid') -Value $server.Id

        $deadline = [DateTime]::UtcNow.AddSeconds(45)
        while (-not (Test-SmartLeadReady)) {
            $server.Refresh()
            if ($server.HasExited) {
                $details = Get-Content -LiteralPath $errorLog -Tail 8 -ErrorAction SilentlyContinue
                throw "SmartLead could not start. $($details -join ' ')"
            }
            if ([DateTime]::UtcNow -ge $deadline) {
                throw "Startup timed out. See $errorLog for details."
            }
            Start-Sleep -Milliseconds 500
        }
    }

    $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 5
    $remoteFeedbackFlag = Join-Path $logDirectory 'feedback-remote-enabled'
    if ($EnableRemoteFeedback) { Set-Content -LiteralPath $remoteFeedbackFlag -Value 'enabled' }
    if ($health.data.mode -eq 'demo' -and (Test-Path -LiteralPath $remoteFeedbackFlag)) {
        $relayReady = $false
        try { $relayHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:3001/__smartlead_feedback_health' -TimeoutSec 2; $relayReady = $relayHealth.running -and $relayHealth.connected } catch {}
        if (-not $relayReady) {
            $relayFile = Join-Path $workspace 'scripts\feedback-relay.ts'
            $relayPidFile = Join-Path $logDirectory 'smartlead-feedback.pid'
            $relayProcess = $null
            if (Test-Path -LiteralPath $relayPidFile) {
                $relayId = [int](Get-Content -LiteralPath $relayPidFile)
                $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $relayId" -ErrorAction SilentlyContinue
                if ($candidate -and $candidate.Name -eq 'node.exe' -and $candidate.CommandLine.Contains($relayFile)) { $relayProcess = Get-Process -Id $relayId }
            }
            if (-not $relayProcess) {
                $cloudflared = Join-Path $workspace 'tools\cloudflared.exe'
                if (-not (Test-Path -LiteralPath $cloudflared)) { throw 'Public feedback needs tools\cloudflared.exe. See README for the official download.' }
                $tsxCli = Join-Path $workspace 'node_modules\tsx\dist\cli.mjs'
                $relayProcess = Start-Process -FilePath $node -ArgumentList @('--import', 'tsx', ('"{0}"' -f $relayFile)) -WorkingDirectory $workspace -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDirectory 'feedback-relay.stdout.log') -RedirectStandardError (Join-Path $logDirectory 'feedback-relay.error.log') -PassThru
                Set-Content -LiteralPath $relayPidFile -Value $relayProcess.Id
            }
            $relayDeadline = [DateTime]::UtcNow.AddSeconds(45)
            do {
                try { $relayHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:3001/__smartlead_feedback_health' -TimeoutSec 2; $relayReady = $relayHealth.running -and $relayHealth.connected } catch {}
                if ($relayReady) { break }
                $relayProcess.Refresh()
                if ($relayProcess.HasExited -or [DateTime]::UtcNow -ge $relayDeadline) { throw 'Public feedback links did not become ready. See data\feedback-relay.log.' }
                Start-Sleep -Milliseconds 500
            } while ($true)
        }
    }
    $workerPidFile = Join-Path $logDirectory 'smartlead-worker.pid'
    if (Test-Path -LiteralPath $workerPidFile) {
        $previousWorker = Get-CimInstance Win32_Process -Filter "ProcessId = $([int](Get-Content -LiteralPath $workerPidFile))" -ErrorAction SilentlyContinue
        if (-not $previousWorker -or -not $previousWorker.CommandLine.Contains((Join-Path $workspace 'src\worker.ts'))) {
            $health.data.workerRunning = $false
        }
    }
    if (-not $health.data.workerRunning) {
        $workerFile = Join-Path $workspace 'src\worker.ts'
        $tsxCli = Join-Path $workspace 'node_modules\tsx\dist\cli.mjs'
        $workerPidFile = Join-Path $logDirectory 'smartlead-worker.pid'
        $worker = $null
        if (Test-Path -LiteralPath $workerPidFile) {
            $savedPid = [int](Get-Content -LiteralPath $workerPidFile)
            $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $savedPid" -ErrorAction SilentlyContinue
            if ($candidate -and $candidate.ExecutablePath -eq $node -and $candidate.CommandLine.Contains($workerFile)) {
                $worker = Get-Process -Id $savedPid
            }
        }
        if (-not $worker) {
            $worker = Start-Process -FilePath $node `
                -ArgumentList @('--import', 'tsx', ('"{0}"' -f $workerFile)) `
                -WorkingDirectory $workspace -WindowStyle Hidden `
                -RedirectStandardOutput (Join-Path $logDirectory 'smartlead-worker.log') `
                -RedirectStandardError (Join-Path $logDirectory 'smartlead-worker.error.log') -PassThru
            Set-Content -LiteralPath $workerPidFile -Value $worker.Id
        }
        $workerDeadline = [DateTime]::UtcNow.AddSeconds(30)
        do {
            $worker.Refresh()
            if ($worker.HasExited) { throw 'Automatic sending could not start. See data\smartlead-worker.error.log.' }
            $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 5
            if ($health.data.workerRunning) { break }
            if ([DateTime]::UtcNow -ge $workerDeadline) { throw 'Automatic sending did not become ready. See data\smartlead-worker.error.log.' }
            Start-Sleep -Milliseconds 500
        } while ($true)
    }

    Write-Host "SmartLead is running: $loginUrl"
    Write-Host 'WhatsApp connections and automatic lead sending are running in the background.'
    Write-Host 'The app keeps running after this window closes. Run Start SmartLead.cmd again after a restart.'
    if (-not $NoBrowser) {
        try { Start-Process $loginUrl }
        catch { Write-Warning "Open $loginUrl in your browser." }
    }
    exit 0
} catch {
    Write-Host "SmartLead startup failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

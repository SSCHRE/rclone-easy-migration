# rclone-easy-migration launcher (Windows). Works on Windows PowerShell 5.1 and PowerShell 7.
#
# Usage: start.ps1 [--no-browser | -NoBrowser] [--allow-sleep] [--help] [extra rclone args...]
#   Any other arguments are passed to "rclone rcd" (e.g. --config C:\path\rclone.conf, -vv).
# Env:   REM_FORCE_DOWNLOAD=1  ignore any installed rclone and offer to download one into ./bin
#        REM_BIN_DIR=<dir>     use <dir> instead of ./bin for the downloaded rclone (testing)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$UiDir     = Join-Path $ScriptDir 'ui'
$BinDir    = if ($env:REM_BIN_DIR) { $env:REM_BIN_DIR } else { Join-Path $ScriptDir 'bin' }
$BasePort  = 5572

# --- argument parsing -------------------------------------------------------
$NoBrowser = $false
$AllowSleep = $false
$Extra = New-Object System.Collections.Generic.List[string]
foreach ($a in $args) {
    switch -Regex ($a) {
        '^(--no-browser|-NoBrowser)$' { $NoBrowser = $true; break }
        '^(--allow-sleep|-AllowSleep)$' { $AllowSleep = $true; break }
        '^(--help|-h|-\?|-Help)$' {
            Write-Host 'Usage: start.ps1 [--no-browser] [extra rclone args...]'
            Write-Host '  --no-browser   do not open the browser automatically'
            Write-Host '  --allow-sleep  do not keep the computer awake while running'
            Write-Host '  anything else is passed to "rclone rcd" (e.g. --config FILE, -vv)'
            exit 0
        }
        default { $Extra.Add([string]$a) }
    }
}

function Fail($msg) {
    Write-Host ''
    Write-Host "ERROR: $msg" -ForegroundColor Red
    exit 1
}

function Quote-Arg([string]$s) {
    if ($s -eq '') { return '""' }
    if ($s -notmatch '[\s"]') { return $s }
    $s = $s -replace '(\\*)"', '$1$1\"'
    $s = $s -replace '(\\+)$', '$1$1'
    return '"' + $s + '"'
}

function Get-RcloneArch {
    $a = $env:PROCESSOR_ARCHITEW6432
    if (-not $a) { $a = $env:PROCESSOR_ARCHITECTURE }
    switch ($a) {
        'AMD64' { return 'amd64' }
        'ARM64' { return 'arm64' }
        'x86'   { return '386' }
        default { Fail "Unsupported CPU architecture '$a'. Install rclone manually from https://rclone.org/downloads/" }
    }
}

function Install-Rclone([string]$destDir) {
    $arch = Get-RcloneArch
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('rem-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
        Write-Host 'Looking up latest rclone version...'
        $ver = ((Invoke-WebRequest -UseBasicParsing -Uri 'https://downloads.rclone.org/version.txt').Content.ToString()).Trim() -replace '^rclone\s+', ''
        if ($ver -notmatch '^v\d+\.\d+\.\d+$') { Fail "Unexpected version string from downloads.rclone.org: '$ver'" }
        $name = "rclone-$ver-windows-$arch.zip"
        $zip  = Join-Path $tmp $name
        Write-Host "Downloading $name ..."
        Invoke-WebRequest -UseBasicParsing -Uri "https://downloads.rclone.org/$ver/$name" -OutFile $zip

        # Verify SHA256 against the published SHA256SUMS
        $sums = (Invoke-WebRequest -UseBasicParsing -Uri "https://downloads.rclone.org/$ver/SHA256SUMS").Content
        if ($sums -is [byte[]]) { $sums = [Text.Encoding]::ASCII.GetString($sums) }
        $expected = $null
        foreach ($line in ($sums -split "`n")) {
            if ($line -match '^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$' -and $Matches[2] -eq $name) { $expected = $Matches[1].ToLower() }
        }
        if (-not $expected) { Fail "Could not find a checksum for $name in SHA256SUMS." }
        $actual = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLower()
        if ($actual -ne $expected) { Fail "Checksum mismatch for $name (expected $expected, got $actual). Download aborted." }
        Write-Host 'Checksum OK.'

        $ex = Join-Path $tmp 'x'
        Expand-Archive -Path $zip -DestinationPath $ex -Force
        $exe = Get-ChildItem -Path $ex -Recurse -Filter 'rclone.exe' | Select-Object -First 1
        if (-not $exe) { Fail 'rclone.exe not found in the downloaded archive.' }
        New-Item -ItemType Directory -Force -Path $destDir | Out-Null
        Copy-Item -Path $exe.FullName -Destination (Join-Path $destDir 'rclone.exe') -Force
    }
    finally {
        Remove-Item -Recurse -Force -Path $tmp -ErrorAction SilentlyContinue
    }
}

# --- checks -----------------------------------------------------------------
if (-not (Test-Path -LiteralPath $UiDir -PathType Container)) {
    Fail "UI folder not found: $UiDir`nMake sure you extracted/cloned the whole project."
}

# --- locate rclone ----------------------------------------------------------
# Prefer the user's EXISTING rclone installation (and therefore their existing config/remotes).
# Order: $env:RCLONE_PATH -> PATH -> common install locations -> ./bin -> offer download.
$Rclone = $null
$local = Join-Path $BinDir 'rclone.exe'
if (-not $env:REM_FORCE_DOWNLOAD) {
    if ($env:RCLONE_PATH -and (Test-Path -LiteralPath $env:RCLONE_PATH)) { $Rclone = $env:RCLONE_PATH }
    if (-not $Rclone) {
        $cmd = Get-Command rclone -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($cmd) { $Rclone = $cmd.Source }
    }
    if (-not $Rclone) {
        $candidates = @(
            (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\rclone.exe'),
            (Join-Path $env:USERPROFILE 'scoop\shims\rclone.exe'),
            (Join-Path $env:ProgramData 'chocolatey\bin\rclone.exe'),
            (Join-Path $env:ProgramFiles 'rclone\rclone.exe'),
            'C:\rclone\rclone.exe'
        )
        # winget also unpacks into Packages\Rclone.Rclone_*\rclone-*\rclone.exe
        $wg = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
        if (Test-Path -LiteralPath $wg) {
            $candidates += Get-ChildItem -LiteralPath $wg -Filter 'Rclone.Rclone*' -Directory -ErrorAction SilentlyContinue |
                ForEach-Object { Get-ChildItem -LiteralPath $_.FullName -Filter rclone.exe -Recurse -ErrorAction SilentlyContinue } |
                ForEach-Object { $_.FullName }
        }
        $Rclone = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
    }
}
if (-not $Rclone -and (Test-Path -LiteralPath $local)) { $Rclone = $local }

if (-not $Rclone) {
    Write-Host 'rclone was not found (looked on your PATH, common install locations and ./bin).'
    Write-Host 'If you already have rclone somewhere else, set RCLONE_PATH to its full path and run this again.'
    $ans = Read-Host "Download rclone now into $BinDir ? [Y/n]"
    if ($ans -match '^(n|no)$') { Fail 'rclone is required. Install it from https://rclone.org/downloads/ and run this again.' }
    Install-Rclone $BinDir
    $Rclone = $local
}

Write-Host ''
& $Rclone version | Select-Object -First 1 | ForEach-Object { Write-Host $_ }
if ($LASTEXITCODE -ne 0) { Fail "Could not run $Rclone" }
Write-Host "Using rclone: $Rclone"
if (-not ($args -match '^--config')) {
    $cfg = & $Rclone config file 2>$null | Select-Object -Last 1
    if ($cfg) { Write-Host "Using config: $($cfg.Trim())  (your existing remotes)" }
}

# --- pick a free port -------------------------------------------------------
function Test-PortFree([int]$p) {
    $l = $null
    try {
        $l = New-Object System.Net.Sockets.TcpListener([Net.IPAddress]::Parse('127.0.0.1'), $p)
        $l.Start()
        return $true
    } catch { return $false }
    finally { if ($l) { try { $l.Stop() } catch { } } }
}
$Port = $null
for ($p = $BasePort; $p -lt $BasePort + 20; $p++) {
    if (Test-PortFree $p) { $Port = $p; break }
}
if (-not $Port) { Fail "No free port found between $BasePort and $($BasePort + 19)." }

# --- credentials ------------------------------------------------------------
function New-RandomString([int]$len) {
    $chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    $rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
    $sb = New-Object System.Text.StringBuilder
    $buf = New-Object byte[] 1
    while ($sb.Length -lt $len) {
        $rng.GetBytes($buf)
        if ($buf[0] -lt 248) { [void]$sb.Append($chars[$buf[0] % 62]) }   # 248 = 62*4, avoids modulo bias
    }
    $rng.Dispose()
    return $sb.ToString()
}
$User = 'rem-' + (New-RandomString 8).ToLower()
$Pass = New-RandomString 28

# --- start rclone -----------------------------------------------------------
$LogFile = $null
if (-not ($Extra | Where-Object { $_ -match '^--log-file' })) {
    $LogDir = Join-Path $ScriptDir 'logs'
    try {
        New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
        $LogFile = Join-Path $LogDir ('rclone-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
    } catch { $LogFile = $null }
}
$rcArgs = @('rcd', '--rc-addr', "127.0.0.1:$Port", '--rc-files', $UiDir, '--rc-job-expire-duration', '24h', '--log-level', 'NOTICE')
if ($LogFile) { $rcArgs += @('--log-file', $LogFile) }
$rcArgs += $Extra.ToArray()
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $Rclone
$psi.Arguments = ($rcArgs | ForEach-Object { Quote-Arg $_ }) -join ' '
$psi.UseShellExecute = $false
$psi.WorkingDirectory = $ScriptDir
$psi.EnvironmentVariables['RCLONE_RC_USER'] = $User
$psi.EnvironmentVariables['RCLONE_RC_PASS'] = $Pass

$proc = $null
$SleepState = 'off'
try {
    if (-not $AllowSleep) {
        try {
            Add-Type -Namespace Rem -Name Power -MemberDefinition '[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'
            # ES_CONTINUOUS | ES_SYSTEM_REQUIRED: block idle sleep, still allow the display to turn off
            if ([Rem.Power]::SetThreadExecutionState([uint32]2147483649) -ne 0) { $SleepState = 'on' }
        } catch { }
    }
    $proc = [System.Diagnostics.Process]::Start($psi)

    # wait for the server
    $ready = $false
    $auth = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("${User}:${Pass}"))
    for ($i = 0; $i -lt 50; $i++) {
        if ($proc.HasExited) { break }
        try {
            $r = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "http://127.0.0.1:$Port/core/version" -Headers @{ Authorization = $auth } -TimeoutSec 2
            if ($r.StatusCode -eq 200) { $ready = $true; break }
        } catch { }
        Start-Sleep -Milliseconds 200
    }
    if (-not $ready) {
        if ($proc.HasExited) { Fail "rclone exited unexpectedly (code $($proc.ExitCode)). See the messages above." }
        Fail 'rclone did not start answering within 10 seconds.'
    }

    $url = "http://127.0.0.1:$Port/"
    Write-Host ''
    Write-Host '==============================================================' -ForegroundColor Cyan
    Write-Host '  rclone-easy-migration is running' -ForegroundColor Cyan
    Write-Host '==============================================================' -ForegroundColor Cyan
    Write-Host "  URL:       $url   (local to this computer only)"
    Write-Host "  Username:  $User"
    Write-Host "  Password:  $Pass"
    if ($LogFile) { Write-Host "  Log file:  $LogFile" }
    if ($SleepState -eq 'on') { Write-Host '  Sleep prevention: on (screen may still turn off; closing a laptop lid may still suspend)' }
    else { Write-Host '  Sleep prevention: off' }
    Write-Host ''
    Write-Host '  If your browser asks for a username/password, use the above.'
    Write-Host '  Press Ctrl+C to stop. Closing this window also stops the app'
    Write-Host '  (and any running transfers). The Quit button in the UI works too.'
    Write-Host ''

    if (-not $NoBrowser) {
        try { Start-Process "http://${User}:${Pass}@127.0.0.1:$Port/" }
        catch { Write-Host "Could not open the browser automatically. Open $url yourself." }
    }

    $proc.WaitForExit()
    Write-Host 'rclone has stopped. Goodbye.'
}
finally {
    if ($SleepState -eq 'on') { try { [void][Rem.Power]::SetThreadExecutionState([uint32]2147483648) } catch { } }
    if ($proc -and -not $proc.HasExited) {
        try { $proc.Kill() } catch { }
    }
}

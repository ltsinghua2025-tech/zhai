[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $Python3Path,
    [switch] $TestInstaller
)

$ErrorActionPreference = 'Stop'
$project = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$python3 = (Resolve-Path $Python3Path).Path
$target = 'x86_64-pc-windows-msvc'
$release = Join-Path $project "src-tauri/target/$target/release"
$tempRoot = if ($env:GITHUB_ACTIONS -eq 'true') { "$($env:SystemDrive)\" } else { [IO.Path]::GetTempPath() }
$scratch = Join-Path $tempRoot ("zhai-build-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch | Out-Null
$ruleNames = @()
$oldProxy = @{}

function Add-TestProgramBlock([string] $File) {
    $path = (Resolve-Path -LiteralPath $File).ProviderPath
    $name = 'zhai-offline-test-' + [guid]::NewGuid().ToString('N')
    try {
        New-NetFirewallRule -Name $name -DisplayName $name -Direction Outbound -Action Block -Program $path -Profile Any -ErrorAction Stop | Out-Null
        $script:ruleNames += $name
        Write-Output "Firewall blocked outbound: $path"
    } catch {
        Write-Output "Firewall unavailable for $path ($($_.Exception.Message)). Dead proxies and browser network emulation remain active."
    }
}

function Restore-Proxy {
    foreach ($key in $oldProxy.Keys) {
        [Environment]::SetEnvironmentVariable($key, $oldProxy[$key], 'Process')
    }
}

function Invoke-Checked {
    param([string] $Program, [string[]] $Arguments)
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Program exited with code $LASTEXITCODE."
    }
}

Push-Location $project
try {
    $env:VITE_WINDOWS_OFFLINE = '1'
    Invoke-Checked $python3 @('-c', 'import struct,sys; assert sys.version_info[:2] == (3,12) and struct.calcsize("P") == 8')
    Invoke-Checked $python3 @('-m', 'venv', (Join-Path $scratch 'python'))
    $python3Env = Join-Path $scratch 'python/Scripts/python.exe'
    Invoke-Checked $python3Env @('-m', 'pip', 'install', '-r', 'engine/requirements.txt', 'pyinstaller==6.16.0')
    Invoke-Checked $python3Env @('-m', 'unittest', 'discover', '-s', 'engine/tests', '-p', 'test_atomic_writer.py', '-v')
    $env:MATERIAL_WORKSHOP_ENGINE_NAME = "material-workshop-engine-$target"
    Push-Location (Join-Path $project 'engine')
    try {
        Invoke-Checked $python3Env @('-m', 'PyInstaller', '--noconfirm', '--clean', '--workpath', (Join-Path $scratch 'work'), '--distpath', (Join-Path $project 'src-tauri/binaries'), 'material-workshop-engine.spec')
    } finally {
        Pop-Location
    }

    Invoke-Checked 'npm.cmd' @('run', 'tauri', 'build', '--', '--target', $target, '--features', 'windows-offline', '--bundles', 'nsis')
    $installers = @(Get-ChildItem -Path (Join-Path $release 'bundle/nsis') -Filter '*-setup.exe' -File)
    if ($installers.Count -ne 1) {
        throw "Expected one Windows installer; found $($installers.Count)."
    }
    $installer = $installers[0].FullName
    Write-Output "Windows installer: $installer"

    if ($TestInstaller) {
        $payload = Join-Path $scratch 'embedded-runtime'
        $sevenZip = (Get-Command 7z -ErrorAction Stop).Source
        Invoke-Checked $sevenZip @('x', '-y', "-o$payload", $installer, '-ir!MicrosoftEdgeWebView2RuntimeInstaller.exe')
        $runtime = @(Get-ChildItem $payload -Recurse -Filter 'MicrosoftEdgeWebView2RuntimeInstaller.exe' -File)
        if ($runtime.Count -ne 1 -or $runtime[0].Length -lt 50MB) {
            throw 'The NSIS contents do not contain a complete offline WebView2 installer.'
        }
        $signature = Get-AuthenticodeSignature $runtime[0].FullName
        if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') {
            throw 'The embedded WebView2 runtime lacks a valid Microsoft signature.'
        }
        Write-Output "Embedded Microsoft offline WebView2 installer verified: $($runtime[0].Length) bytes, SHA256 $((Get-FileHash $runtime[0].FullName).Hash)"
        $webviewPath = Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'Microsoft/EdgeWebView/Application'
        $installedWebviews = @(Get-ChildItem $webviewPath -Directory -ErrorAction SilentlyContinue |
            Where-Object { Test-Path (Join-Path $_.FullName 'msedgewebview2.exe') } | Select-Object -ExpandProperty Name)
        Write-Output "WebView2 versions present before installation: $($installedWebviews -join ', ')"
        $install = Join-Path $scratch 'install'
        $app = Join-Path $install 'material-workshop-desktop.exe'
        $engine = Join-Path $install 'material-workshop-engine.exe'
        if ($env:GITHUB_ACTIONS -eq 'true') {
            foreach ($key in @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY')) {
                $oldProxy[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
            }
            $env:HTTP_PROXY = 'http://127.0.0.1:9'
            $env:HTTPS_PROXY = $env:HTTP_PROXY
            $env:ALL_PROXY = $env:HTTP_PROXY
            $env:NO_PROXY = '127.0.0.1,localhost,.localhost'
            $localSetup = Join-Path $scratch 'offline-setup.exe'
            Copy-Item $installer $localSetup
            if ((Get-FileHash $localSetup).Hash -ne (Get-FileHash $installer).Hash) { throw 'C: setup copy differs.' }
            $installer = $localSetup
            Add-TestProgramBlock $installer
        }
        $process = Start-Process -FilePath $installer -ArgumentList '/S', "/D=$install" -Wait -PassThru
        if ($process.ExitCode -ne 0 -or !(Test-Path $app -PathType Leaf) -or !(Test-Path $engine -PathType Leaf)) {
            throw "Offline setup failed ($($process.ExitCode)) or installed files are missing."
        }
        if ($env:GITHUB_ACTIONS -eq 'true') {
            Add-TestProgramBlock $app
            Add-TestProgramBlock $engine
            Write-Output "Offline acceptance network mode: dead HTTP(S) proxy, WebView offline emulation; $($ruleNames.Count) per-program outbound firewall rules."
        }
        $unexpected = @(Get-ChildItem $install -File -Recurse | Where-Object { $_.Name -match '(?i)codex.*\.exe$|judge.*\.key$|private-config\.json$' })
        if ($unexpected) { throw 'Unexpected online runtime or provisioning material in offline installation.' }
        Invoke-Checked $python3Env @((Join-Path $project 'scripts/diagnose-windows-imports.py'), $app)

        $originalTemp = $env:TEMP
        $originalTmp = $env:TMP
        try {
            $env:TEMP = $scratch
            $env:TMP = $scratch
            $check = Start-Process -FilePath $app -ArgumentList '--self-check' -PassThru
            if (!$check.WaitForExit(180000)) {
                Stop-Process -Id $check.Id -Force
                throw 'Installed offline application self-check timed out.'
            }
            $reports = @(Get-ChildItem $scratch -Filter 'zhai-self-check-*' -Directory | ForEach-Object {
                Get-Item (Join-Path $_.FullName 'report.json') -ErrorAction SilentlyContinue
            })
            if ($reports.Count -ne 1) { throw "No unique self-check report after exit $($check.ExitCode)." }
            $reportText = Get-Content $reports[0].FullName -Raw -Encoding utf8
            Write-Output $reportText
            $report = $reportText | ConvertFrom-Json
            if ($check.ExitCode -ne 0 -or !$report.success -or $report.edition -ne 'windows-offline') {
                throw 'Installed offline Word, Excel or PDF validation failed.'
            }
        } finally {
            $env:TEMP = $originalTemp
            $env:TMP = $originalTmp
        }

        if ($env:GITHUB_ACTIONS -eq 'true') {
            $dataDir = Join-Path $env:APPDATA 'cn.materialworkbench.desktop'
            $database = Join-Path $dataDir 'history.sqlite3'
            if (Test-Path $database) { throw 'A fresh CI user profile is required for the GUI test.' }
            $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
            $listener.Start()
            $port = $listener.LocalEndpoint.Port
            $listener.Stop()
            $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$port --remote-debugging-address=127.0.0.1 --disable-background-networking --proxy-server=http://127.0.0.1:9 --proxy-bypass-list=localhost;127.0.0.1;*.localhost"
            $env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $scratch 'gui-webview'
            $gui = Start-Process -FilePath $app -PassThru
            try {
                & node (Join-Path $project 'scripts/check-windows-offline-gui.mjs') "$port"
                $rendererExit = $LASTEXITCODE
                if ($rendererExit -eq 2) {
                    $gui.Refresh()
                    if ($gui.HasExited -or $gui.MainWindowHandle -eq 0 -or $gui.MainWindowTitle -notmatch '离线工具版') {
                        throw "Installed offline window did not open: $($gui.MainWindowTitle)"
                    }
                    Write-Output "Observed native window: $($gui.MainWindowTitle). Renderer contents not inspected via CDP."
                } elseif ($rendererExit -ne 0) {
                    throw "Installed WebView content verification failed ($rendererExit)."
                }
                $query = 'import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); assert not db.execute("SELECT count(*) FROM ai_profiles WHERE id=? OR key_stored=1",("zhai-tianyi",)).fetchone()[0]'
                if (!(Test-Path $database) -or (Test-Path (Join-Path $dataDir 'judge-tianyi-initialized'))) {
                    throw 'Fresh offline profile was not initialized correctly.'
                }
                Invoke-Checked $python3 @('-c', $query, $database)
                Write-Output 'Fresh installed offline GUI and local profile initialized without model credentials.'
            } finally {
                Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue
                Remove-Item Env:WEBVIEW2_USER_DATA_FOLDER -ErrorAction SilentlyContinue
                if (!$gui.HasExited) { Stop-Process -Id $gui.Id -Force }
            }
        }
    }

    Restore-Proxy
    $env:ZHAI_TEST_PYTHON3 = $python3Env
    $argsForTests = @('test', '--release', '--locked', '--lib', '--features', 'windows-offline', '--manifest-path', 'src-tauri/Cargo.toml', '--target', $target)
    $messages = & cargo @argsForTests --no-run --message-format=json
    if ($LASTEXITCODE -ne 0) { throw 'Native Rust test build failed.' }
    $binaries = @($messages | ForEach-Object { $_ | ConvertFrom-Json } |
        Where-Object { $_.reason -eq 'compiler-artifact' -and $_.profile.test -and $_.executable } |
        ForEach-Object { $_.executable })
    if ($binaries.Count -ne 1) { throw 'Expected one native Rust library test executable.' }
    Invoke-Checked $python3Env @((Join-Path $project 'scripts/diagnose-windows-imports.py'), $binaries[0])
    Invoke-Checked $binaries[0] @('process_runner::tests', '--nocapture')
    Invoke-Checked $binaries[0] @('offline_install_has_only_builtin_local_tools_and_no_model_profile', '--nocapture')
} finally {
    Restore-Proxy
    foreach ($name in $ruleNames) {
        Remove-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue
    }
    Pop-Location
}

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
    Invoke-Checked $python3Env @('-m', 'unittest', 'discover', '-s', 'engine/tests', '-p', 'test_external_office.py', '-v')
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
        $config = Get-Content (Join-Path $project 'src-tauri/tauri.windows.conf.json') -Raw | ConvertFrom-Json
        $mode = $config.bundle.windows.webviewInstallMode.type
        $fullName = 'MicrosoftEdgeWebView2RuntimeInstaller.exe'
        $bootstrapName = 'MicrosoftEdgeWebview2Setup.exe'
        Invoke-Checked $sevenZip @('x', '-y', "-o$payload", $installer, "-ir!$fullName", "-ir!$bootstrapName")
        $runtime = @(Get-ChildItem $payload -Recurse -File)
        if ($runtime.Count -ne 1) { throw 'Expected exactly one embedded Microsoft WebView2 installer.' }
        if ($mode -eq 'embedBootstrapper') {
            if ($runtime[0].Name -ne $bootstrapName -or $runtime[0].Length -ge 10MB) {
                throw 'The lightweight installer does not contain the expected small WebView2 bootstrapper.'
            }
        } elseif ($mode -ne 'offlineInstaller' -or $runtime[0].Name -ne $fullName -or $runtime[0].Length -lt 50MB) {
            throw 'The NSIS contents do not match the configured WebView2 install mode.'
        }
        $signature = Get-AuthenticodeSignature $runtime[0].FullName
        if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') {
            throw 'The embedded WebView2 runtime lacks a valid Microsoft signature.'
        }
        Write-Output "Verified Microsoft WebView2 package ($mode): $($runtime[0].Length) bytes, SHA256 $((Get-FileHash $runtime[0].FullName).Hash)"
        $webviewPath = Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'Microsoft/EdgeWebView/Application'
        $installedWebviews = @(Get-ChildItem $webviewPath -Directory -ErrorAction SilentlyContinue |
            Where-Object { Test-Path (Join-Path $_.FullName 'msedgewebview2.exe') } | Select-Object -ExpandProperty Name)
        Write-Output "WebView2 versions present before installation: $($installedWebviews -join ', ')"
        if ($mode -eq 'embedBootstrapper' -and $installedWebviews.Count -eq 0) {
            throw 'Offline installation of the lightweight package requires an existing WebView2 runtime on this test machine.'
        }
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
            if (!$check.WaitForExit(360000)) {
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

            if ($report.legacyDocConverted) {
                Write-Output 'The initial test already used a local converter to validate a real binary DOC.'
            } else {
                # This optional runtime is installed on the CI machine only, after building and testing the clean package.
                $msi = Join-Path $scratch 'libreoffice-x64.msi'
                $url = 'https://download.documentfoundation.org/libreoffice/stable/26.8.3/win/x86_64/LibreOffice_26.8.3_Win_x86-64.msi'
                $expected = '0E6918C273EABBDBBD800EE0DACBBF130A14C13C2E4CEC861B06DD59E015BF94'
                Write-Output 'Installing the official LibreOffice 26.8.3 x64 runtime on the CI machine for the conditional DOC conversion test.'
                Invoke-Checked 'curl.exe' @('--noproxy', '*', '--fail', '--location', '--silent', '--show-error', '--retry', '2', '--retry-max-time', '300', '--max-time', '240', '--output', $msi, $url)
                if ((Get-FileHash $msi -Algorithm SHA256).Hash -ne $expected) { throw 'LibreOffice MSI hash mismatch.' }
                $signature = Get-AuthenticodeSignature $msi
                if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'The Document Foundation') {
                    throw "LibreOffice MSI publisher verification failed: $($signature.Status) $($signature.SignerCertificate.Subject)"
                }
                $installOffice = Start-Process msiexec.exe -ArgumentList '/i', $msi, '/qn', '/norestart', 'REGISTER_NO_MSO_TYPES=1' -PassThru
                if (!$installOffice.WaitForExit(300000) -or $installOffice.ExitCode -notin 0,3010) {
                    throw "LibreOffice installation on the CI machine failed or timed out: $($installOffice.ExitCode)"
                }
                $officeDir = Join-Path $env:ProgramFiles 'LibreOffice/program'
                foreach ($binary in 'soffice.com','soffice.exe','soffice.bin') {
                    Add-TestProgramBlock (Join-Path $officeDir $binary)
                }
                $legacyTemp = Join-Path "$($env:SystemDrive)\" ('zl-' + [guid]::NewGuid().ToString('N').Substring(0,8))
                New-Item -ItemType Directory -Path $legacyTemp | Out-Null
                try {
                    $env:TEMP = $legacyTemp
                    $env:TMP = $legacyTemp
                    $versionOut = Join-Path $legacyTemp 'soffice-version.txt'
                    $versionErr = Join-Path $legacyTemp 'soffice-version-err.txt'
                    $versionProbe = Start-Process (Join-Path $officeDir 'soffice.com') -ArgumentList '--headless','--version' -PassThru -NoNewWindow -RedirectStandardOutput $versionOut -RedirectStandardError $versionErr
                    if (!$versionProbe.WaitForExit(30000)) {
                        & taskkill.exe /PID $versionProbe.Id /T /F
                        throw 'The installed LibreOffice command-line version probe did not exit within 30 seconds.'
                    }
                    $officeVersion = Get-Content $versionOut -Raw
                    if ($versionProbe.ExitCode -ne 0 -or $officeVersion -notmatch 'LibreOffice') {
                        throw "The installed soffice.com did not report a version ($($versionProbe.ExitCode)): $(Get-Content $versionErr -Raw)"
                    }
                    Write-Output "Offline command-line probe: $($officeVersion.Trim())"
                    $controlDir = Join-Path $legacyTemp 'control'
                    New-Item -ItemType Directory -Path $controlDir | Out-Null
                    $controlDoc = Join-Path $controlDir 'legacy.doc'
                    Copy-Item (Join-Path $reports[0].DirectoryName 'xlsx-fixtures/legacy.doc') $controlDoc
                    $profileUri = ([System.Uri](Join-Path $controlDir 'profile')).AbsoluteUri
                    $control = Start-Process (Join-Path $officeDir 'soffice.com') -PassThru -NoNewWindow -ArgumentList @(
                        '--headless','--nologo','--nodefault','--norestore','--nofirststartwizard',
                        "-env:UserInstallation=$profileUri",'--convert-to','"docx:Office Open XML Text"','--outdir',$controlDir,$controlDoc
                    )
                    if (!$control.WaitForExit(120000)) {
                        & taskkill.exe /PID $control.Id /T /F
                        throw 'Offline conversion of the binary DOC timed out in standalone LibreOffice before the installed-app check.'
                    }
                    $controlOutput = Join-Path $controlDir 'legacy.docx'
                    if ($control.ExitCode -ne 0 -or !(Test-Path $controlOutput -PathType Leaf)) {
                        throw "Standalone LibreOffice did not generate the control DOCX ($($control.ExitCode))."
                    }
                    Invoke-Checked $python3Env @('-c', 'import sys; from docx import Document; assert any("Office compatibility sample 6247" in p.text for p in Document(sys.argv[1]).paragraphs)', $controlOutput)
                    Write-Output 'Standalone LibreOffice converted the genuine binary DOC while offline; reopening the control output succeeded.'
                    $env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $legacyTemp 'webview'
                    $checkLegacy = Start-Process $app -ArgumentList '--self-check','--legacy-doc-only' -PassThru
                    $timer = [Diagnostics.Stopwatch]::StartNew()
                    $lastStage = ''
                    while (!$checkLegacy.WaitForExit(15000)) {
                        $marker = @(Get-ChildItem "$legacyTemp/zhai-self-check-*/legacy-stage.txt" -File -ErrorAction SilentlyContinue)
                        $stage = if ($marker) { Get-Content $marker[0].FullName -Raw } else { 'opening the installed window and preparing self-check' }
                        if ($stage -ne $lastStage) {
                            Write-Output "Legacy DOC verification: $stage"
                            $lastStage = $stage
                        }
                        if ($timer.Elapsed.TotalSeconds -ge 300) {
                            Get-CimInstance Win32_Process |
                                Where-Object { $_.Name -like 'soffice*' -or $_.Name -like 'material-workshop*' } |
                                Select-Object Name,ProcessId,ParentProcessId,CommandLine | Format-List | Out-Host
                            Get-ChildItem $legacyTemp -Recurse -File -ErrorAction SilentlyContinue |
                                Where-Object { $_.Name -in @('request.json','report.json','legacy.doc','legacy-stage.txt') } |
                                Select-Object FullName,Length | Format-List | Out-Host
                            & taskkill.exe /PID $checkLegacy.Id /T /F
                            throw "Installed-app legacy DOC conversion timed out; last stage: $stage."
                        }
                    }
                    $proof = @(Get-ChildItem "$legacyTemp/zhai-self-check-*/report.json" -File)
                    if ($proof.Count -ne 1) { throw 'Missing legacy DOC conversion check report.' }
                    $json = Get-Content $proof[0].FullName -Raw -Encoding utf8
                    Write-Output $json
                    $result = $json | ConvertFrom-Json
                    if ($checkLegacy.ExitCode -ne 0 -or !$result.success -or !$result.legacyDocConverted) {
                        throw 'The installed app did not convert and reopen the legacy DOC with the optional runtime.'
                    }
                } finally {
                    Remove-Item Env:WEBVIEW2_USER_DATA_FOLDER -ErrorAction SilentlyContinue
                    $env:TEMP = $originalTemp
                    $env:TMP = $originalTmp
                }
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

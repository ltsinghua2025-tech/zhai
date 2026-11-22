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
$scratch = Join-Path ([System.IO.Path]::GetTempPath()) ("zhai-build-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch | Out-Null

function Invoke-Checked {
    param([string] $Program, [string[]] $Arguments)
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Program exited with code $LASTEXITCODE."
    }
}

Push-Location $project
try {
    Invoke-Checked $python3 @('-c', 'import struct,sys; assert sys.version_info[:2] == (3,12) and struct.calcsize("P") == 8')
    Invoke-Checked $python3 @('-m', 'venv', (Join-Path $scratch 'python'))
    $python3Env = Join-Path $scratch 'python/Scripts/python.exe'
    Invoke-Checked $python3Env @('-m', 'pip', 'install', '-r', 'engine/requirements.txt', 'pyinstaller==6.16.0')

    $env:MATERIAL_WORKSHOP_ENGINE_NAME = "material-workshop-engine-$target"
    Push-Location (Join-Path $project 'engine')
    try {
        Invoke-Checked $python3Env @('-m', 'PyInstaller', '--noconfirm', '--clean', '--workpath', (Join-Path $scratch 'work'), '--distpath', (Join-Path $project 'src-tauri/binaries'), 'material-workshop-engine.spec')
    } finally {
        Pop-Location
    }

    Invoke-Checked 'npm.cmd' @('run', 'tauri', 'build', '--', '--target', $target, '--bundles', 'nsis')
    $installers = @(Get-ChildItem -Path (Join-Path $release 'bundle/nsis') -Filter '*-setup.exe' -File)
    if ($installers.Count -ne 1) {
        throw "Expected one Windows installer; found $($installers.Count)."
    }
    Write-Output "Windows installer: $($installers[0].FullName)"
    if (!$TestInstaller) {
        $env:ZHAI_TEST_PYTHON3 = $python3Env
        Invoke-Checked 'cargo' @('test', '--release', '--locked', '--lib', '--manifest-path', 'src-tauri/Cargo.toml', '--target', $target, 'process_runner::tests')
        return
    }

    # Check the contents actually installed by NSIS, rather than using the
    # build tree's copy of the sidecar as an implicit fallback.
    $install = Join-Path $scratch 'install'
    $package = Start-Process -FilePath $installers[0].FullName -ArgumentList '/S', "/D=$install" -Wait -PassThru
    if ($package.ExitCode -ne 0) {
        throw "Windows installer exited with code $($package.ExitCode)."
    }
    $app = Join-Path $install 'material-workshop-desktop.exe'
    $engine = Join-Path $install 'material-workshop-engine.exe'
    if (!(Test-Path $app -PathType Leaf) -or !(Test-Path $engine -PathType Leaf)) {
        throw 'The installed application or its packaged file engine is missing.'
    }
    $inspectImports = Join-Path $project 'scripts/diagnose-windows-imports.py'
    Invoke-Checked $python3Env @($inspectImports, $app)
    $originalTemp = $env:TEMP
    $originalTmp = $env:TMP
    try {
        $env:TEMP = $scratch
        $env:TMP = $scratch
        $check = Start-Process -FilePath $app -ArgumentList '--self-check' -PassThru
        if (!$check.WaitForExit(120000)) {
            Stop-Process -Id $check.Id -Force
            throw 'Installed Windows application self-check timed out.'
        }
        $reports = @(Get-ChildItem -Path $scratch -Filter 'zhai-self-check-*' -Directory |
            ForEach-Object { Get-Item -Path (Join-Path $_.FullName 'report.json') -ErrorAction SilentlyContinue })
        if ($reports.Count -ne 1) {
            throw "Installed application exited with code $($check.ExitCode) without a single self-check report."
        }
        $reportText = Get-Content -Path $reports[0].FullName -Raw -Encoding utf8
        $reportText | Write-Output
        $report = $reportText | ConvertFrom-Json
        $failedSelfCheck = ($check.ExitCode -ne 0 -or -not $report.success)
        if ($failedSelfCheck) {
            $diagnostics = @'
from pathlib import Path
import sqlite3, sys
root = Path(sys.argv[1]).parent
path = root / "data" / "history.sqlite3"
if path.is_file():
    with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True) as db:
        for row in db.execute("SELECT tool_id,status,substr(detail,1,1000) FROM agent_tool_runs ORDER BY started_at"):
            print("Synthetic tool execution:", ascii(row))
        for row in db.execute("SELECT status,failed_files,report_path FROM jobs ORDER BY created_at"):
            print("Synthetic file job:", ascii(row))
'@
            Invoke-Checked $python3 @('-c', $diagnostics, $reports[0].FullName)
        }
    } finally {
        $env:TEMP = $originalTemp
        $env:TMP = $originalTmp
    }

    # Test the same bootstrap used for domestic downloads with a synthetic
    # resource. The public installer must leave a new installation unconfigured.
    $installedResource = Join-Path $install 'judge-tianyi.key'
    if (Test-Path $installedResource) {
        throw 'The ordinary installer unexpectedly included a judge credential.'
    }
    $compiler = Get-Command makensis -ErrorAction SilentlyContinue
    $makensis = if ($compiler) {
        $compiler.Source
    } else {
        Get-ChildItem (Join-Path $env:LOCALAPPDATA 'tauri') -Filter makensis.exe -Recurse -File |
            Select-Object -First 1 -ExpandProperty FullName
    }
    if (!$makensis) {
        throw 'Cannot find the NSIS compiler used to build the installer.'
    }
    $synthetic = Join-Path $scratch 'synthetic.key'
    [IO.File]::WriteAllText($synthetic, 'synthetic-installation-test')
    $judgeSetup = Join-Path $scratch 'judge-setup.exe'
    Invoke-Checked $makensis @('/V2', "/DINSTALLER_FILE=$($installers[0].FullName)", "/DJUDGE_RESOURCE=$synthetic", "/DOUTPUT_FILE=$judgeSetup", (Join-Path $project 'scripts/windows-judge.nsi'))
    $judgeInstall = Start-Process -FilePath $judgeSetup -ArgumentList '/S', "/D=$install" -Wait -PassThru
    if ($judgeInstall.ExitCode -ne 0 -or !(Test-Path $installedResource) -or
        (Get-FileHash $installedResource).Hash -ne (Get-FileHash $synthetic).Hash) {
        throw 'The judge installation failed to provision its synthetic resource.'
    }
    Write-Output 'Judge bootstrap installed the expected synthetic resource.'
    if ($env:GITHUB_ACTIONS -eq 'true') {
        # Only launch a synthetic judge build in a disposable CI user's profile.
        $dataDir = Join-Path $env:APPDATA 'cn.materialworkbench.desktop'
        $database = Join-Path $dataDir 'history.sqlite3'
        $marker = Join-Path $dataDir 'judge-tianyi-initialized'
        if ((Test-Path $database) -or (Test-Path $marker)) {
            throw 'The native first-run check requires a fresh Windows user profile.'
        }
        $gui = Start-Process -FilePath $app -PassThru
        try {
            $deadline = [DateTime]::UtcNow.AddSeconds(60)
            while (!(Test-Path $marker) -and !$gui.HasExited -and [DateTime]::UtcNow -lt $deadline) {
                Start-Sleep -Milliseconds 300
            }
            if (!(Test-Path $marker) -or !(Test-Path $database)) {
                throw 'Normal application startup did not finish provisioning.'
            }
            $query = @'
import sqlite3, sys
with sqlite3.connect(sys.argv[1]) as db:
    row = db.execute("SELECT base_url, key_stored FROM ai_profiles WHERE id=?", ("zhai-tianyi",)).fetchone()
assert row == ("https://ai.ctaigw.cn/v1", 1), "Model profile was not provisioned"
'@
            Invoke-Checked $python3 @('-c', $query, $database)
            Write-Output 'Fresh Windows GUI startup saved the synthetic judge profile in Credential Manager.'
        } finally {
            if (!$gui.HasExited) {
                Stop-Process -Id $gui.Id -Force
            }
        }
    }

    $env:ZHAI_TEST_PYTHON3 = $python3Env
    $testArgs = @('test', '--release', '--locked', '--lib', '--manifest-path', 'src-tauri/Cargo.toml', '--target', $target)
    $messages = & cargo @testArgs --no-run --message-format=json
    if ($LASTEXITCODE -ne 0) {
        throw "Native Rust test build failed ($LASTEXITCODE)."
    }
    $testExecutables = @($messages | ForEach-Object { $_ | ConvertFrom-Json } |
        Where-Object { $_.reason -eq 'compiler-artifact' -and $_.profile.test -and $_.executable } |
        ForEach-Object { $_.executable })
    if ($testExecutables.Count -ne 1) {
        throw "Expected one Rust library test executable; found $($testExecutables.Count)."
    }
    Invoke-Checked $python3Env @($inspectImports, $testExecutables[0])
    Invoke-Checked $testExecutables[0] @('process_runner::tests', '--nocapture')
    if ($failedSelfCheck) {
        throw 'Installed Windows application self-check failed. See its report above.'
    }
} finally {
    Pop-Location
}

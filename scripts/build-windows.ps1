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
    $env:ZHAI_TEST_PYTHON3 = $python3Env
    Invoke-Checked 'cargo' @('test', '--locked', '--manifest-path', 'src-tauri/Cargo.toml', '--target', $target, 'process_runner::tests')

    $installers = @(Get-ChildItem -Path (Join-Path $release 'bundle/nsis') -Filter '*-setup.exe' -File)
    if ($installers.Count -ne 1) {
        throw "Expected one Windows installer; found $($installers.Count)."
    }
    Write-Output "Windows installer: $($installers[0].FullName)"
    if (!$TestInstaller) {
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
        if ($check.ExitCode -ne 0 -or -not $report.success) {
            throw 'Installed Windows application self-check failed.'
        }
    } finally {
        $env:TEMP = $originalTemp
        $env:TMP = $originalTmp
    }
} finally {
    Pop-Location
}

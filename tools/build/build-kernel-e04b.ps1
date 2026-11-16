$ErrorActionPreference = 'Stop'
$e04bRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$e04bRuntime = Join-Path $e04bRoot 'artifacts/tool-cache/E00C/runtime/Hopsan-2.24.4-win64'
$e04bOutput = Join-Path $e04bRoot 'artifacts/tool-cache/E04B/native'
New-Item -ItemType Directory -Force -Path $e04bOutput | Out-Null
$e04bOldPath = $env:PATH
try {
    $env:PATH = "$e04bRuntime/mingw64/bin;$e04bRuntime/bin;$e04bOldPath"
    $e04bFlags = @('-std=c++11', '-O2', '-Wall', '-Wextra', '-DHOPSANCORE_DLLIMPORT', "-I$e04bRuntime/HopsanCore/include")
    & "$e04bRuntime/mingw64/bin/g++.exe" @e04bFlags (Join-Path $e04bRoot 'apps/desktop/native/kernel-host.cpp') "$e04bRuntime/bin/hopsancore.dll" -o "$e04bOutput/kernel-host.exe"
    if ($LASTEXITCODE -ne 0) { throw "Host compiler exit $LASTEXITCODE" }
    & "$e04bRuntime/mingw64/bin/g++.exe" @e04bFlags -shared (Join-Path $e04bRoot 'apps/desktop/native/teaching-restriction.cpp') "$e04bRuntime/bin/hopsancore.dll" -o "$e04bOutput/teaching-components.dll"
    if ($LASTEXITCODE -ne 0) { throw "Component compiler exit $LASTEXITCODE" }
    $e04bFiles = @('kernel-host.exe', 'teaching-components.dll') | ForEach-Object {
        [ordered]@{ path=$_; sha256=(Get-FileHash -LiteralPath (Join-Path $e04bOutput $_) -Algorithm SHA256).Hash.ToLowerInvariant() }
    }
    $e04bSources = @('apps/desktop/native/kernel-host.cpp', 'apps/desktop/native/teaching-restriction.cpp', 'apps/desktop/native/teaching-pilot-relief.hpp', 'apps/desktop/native/teaching-directional.hpp', 'apps/desktop/native/teaching-manifold.hpp', 'apps/desktop/native/teaching-pressure-valves.hpp', 'apps/desktop/native/teaching-load-valves.hpp', 'apps/desktop/native/teaching-accumulator.hpp', 'apps/desktop/native/teaching-shuttle.hpp', 'apps/desktop/native/teaching-pressure-logic.hpp', 'apps/desktop/native/teaching-actuator.hpp', 'apps/desktop/native/teaching-oil-storage.hpp', 'apps/desktop/native/teaching-motor-cavity.hpp', 'apps/desktop/native/teaching-cylinder-cavity.hpp', 'apps/desktop/native/teaching-divider-instrument.hpp', 'apps/desktop/native/teaching-passive-pressure.hpp', 'apps/desktop/native/teaching-hysteretic-pressure.hpp', 'apps/desktop/native/teaching-motor-curve.hpp') | ForEach-Object {
        [ordered]@{ path=$_; sha256=(Get-FileHash -LiteralPath (Join-Path $e04bRoot $_) -Algorithm SHA256).Hash.ToLowerInvariant() }
    }
    $e04bManifest = [ordered]@{ format='HydraulicWorkbenchNativeBuild'; version=1; core='2.24.4.20260918.1254'; modelSet='0.9.0'; architecture='x64'; sources=$e04bSources; files=$e04bFiles } |
        ConvertTo-Json -Depth 5
    [System.IO.File]::WriteAllText("$e04bOutput/manifest.json", $e04bManifest, [System.Text.UTF8Encoding]::new($false))
} finally { $env:PATH = $e04bOldPath }

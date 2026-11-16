# Standalone Windows PowerShell 5.1+ client. A UTF-8 request arrives on stdin;
# Auto-discovery decrypts a current-user DPAPI record outside the project.
# Explicit trusted environment credentials remain compatible.
param(
    [ValidateSet('Auto', 'Manual')]
    [string]$ConnectionMode = 'Auto'
)
$ErrorActionPreference = 'Stop'
# This standalone process uses only its own built-in modules, not inherited PowerShell 7 modules.
$env:PSModulePath = Join-Path $PSHOME 'Modules'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
    $endpoint = $env:HYD_TOOLS_ENDPOINT
    $token = $env:HYD_TOOLS_TOKEN
    if ($ConnectionMode -eq 'Auto') {
        if (-not [string]::IsNullOrEmpty($endpoint) -or -not [string]::IsNullOrEmpty($token)) {
            [Console]::Error.WriteLine('Automatic mode ignores manual environment credentials. Use -ConnectionMode Manual only for an explicitly selected manual connection.')
        }
        $endpoint = $null
        $token = $null
        $connectionDirectory = $env:HYD_TOOLS_CONNECTION_DIR
        if ([string]::IsNullOrEmpty($connectionDirectory)) {
            $connectionDirectory = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'HydraulicWorkbench\advanced'
        }
        if (-not [IO.Path]::IsPathRooted($connectionDirectory)) { throw 'Invalid discovery directory.' }
        $connectionFile = Join-Path $connectionDirectory 'ai-connection.json'
        $item = Get-Item -LiteralPath $connectionFile
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -gt 16384) { throw 'Invalid discovery record.' }
        $connection = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($connectionFile, [Text.Encoding]::UTF8))
        $keys = @('format','version','protection','endpoint','connectionId','protectedToken')
        foreach ($key in $connection.PSObject.Properties.Name) { if ($keys -notcontains $key) { throw 'Unsupported discovery field.' } }
        if ($connection.format -cne 'HydraulicToolsConnection' -or $connection.version -ne 1 -or $connection.protection -cne 'windows-dpapi-current-user' -or $connection.connectionId -cnotmatch '^tools_[a-zA-Z0-9_-]{1,40}$' -or $connection.protectedToken -cnotmatch '^[a-fA-F0-9]{100,8192}$') { throw 'Unsupported discovery record.' }
        $endpoint = $connection.endpoint
        $secret = ConvertTo-SecureString -String $connection.protectedToken
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
        try { $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer); $secret.Dispose() }
    }
    if ($endpoint -notmatch '^http://127\.0\.0\.1:[0-9]+/tools$' -or $token -cnotmatch '^[a-f0-9]{64}$') {
        throw 'Enable AI operations in the workbench or provide trusted manual credentials.'
    }
    $inputJson = [Console]::In.ReadToEnd()
    $bytes = [Text.Encoding]::UTF8.GetBytes($inputJson)
    if ($bytes.Length -gt 1048576) { throw 'Request exceeds 1 MiB.' }
    $null = ConvertFrom-Json -InputObject $inputJson
    $response = Invoke-WebRequest -UseBasicParsing -Uri $endpoint -Method Post -ContentType 'application/json; charset=utf-8' -Headers @{ Authorization = 'Bearer ' + $token } -Body $bytes -TimeoutSec 12
    $content = $response.Content
    if ($content -is [byte[]]) { $content = [Text.UTF8Encoding]::new($false, $true).GetString($content) }
    if ([Text.Encoding]::UTF8.GetByteCount($content) -gt 4194304) { throw 'Response exceeds 4 MiB.' }
    $reply = ConvertFrom-Json -InputObject $content
    [Console]::Out.WriteLine($content)
    if ($reply.ok -ne $true) { exit 1 }
} catch {
    # HTTP failures must not echo Authorization headers, credentials or a project.
    if ($ConnectionMode -eq 'Auto') {
        [Console]::Error.WriteLine('Automatic local connection failed. Enable AI operations in the target workbench, check the current Windows account and discovery directory, then capture again. No edit was confirmed.')
    } else {
        [Console]::Error.WriteLine('Explicit manual connection failed. Refresh both endpoint and token from the current workbench session or return to Auto mode. No automatic fallback or edit was confirmed.')
    }
    exit 1
}

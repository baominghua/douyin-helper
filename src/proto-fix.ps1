param(
    [ValidateSet('apply', 'remove', 'status')]
    [string]$Action = 'apply',
    [string]$Vbs = ''
)

# Registers a silent handler for the bitbrowser:// scheme under HKCU
# (no admin rights needed). It exists only to stop Windows from showing
# "get an app to open this bitbrowser link" whenever Douyin's client
# probes for BitBrowser from a hidden iframe.

$ErrorActionPreference = 'Stop'
$root = 'HKCU:\Software\Classes\bitbrowser'
$cmdKey = Join-Path $root 'shell\open\command'

try {
    switch ($Action) {
        'apply' {
            if (-not $Vbs -or -not (Test-Path $Vbs)) {
                Write-Output ('ERR sink script missing: ' + $Vbs)
                exit 1
            }
            New-Item -Path $root -Force | Out-Null
            Set-Item -Path $root -Value 'URL:bitbrowser Protocol'
            New-Item -Path (Join-Path $root 'URL Protocol') -Force | Out-Null
            Set-Item -Path (Join-Path $root 'URL Protocol') -Value ''
            $exe = Join-Path $env:SystemRoot 'System32\wscript.exe'
            $cmd = '"' + $exe + '" //B //Nologo "' + $Vbs + '" "%1"'
            New-Item -Path $cmdKey -Force | Out-Null
            Set-Item -Path $cmdKey -Value $cmd
            Write-Output ('OK ' + $cmd)
        }
        'remove' {
            if (Test-Path $root) {
                Remove-Item -Path $root -Recurse -Force -ErrorAction Stop
                Write-Output 'REMOVED'
            } else {
                Write-Output 'NOTHING'
            }
        }
        'status' {
            if (Test-Path $cmdKey) {
                Write-Output ('REG ' + (Get-Item $cmdKey).GetValue(''))
            } else {
                Write-Output 'NONE'
            }
        }
    }
} catch {
    Write-Output ('ERR ' + $_.Exception.Message)
    exit 1
}

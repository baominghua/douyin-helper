param([switch]$Once)

# 常驻探针：持续输出抖音客户端窗口的屏幕矩形（物理像素）
# 每行一个 JSON，Electron 主进程直接读 stdout
# 用 -WindowStyles 判断窗口是否最小化 / 可见

$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -Namespace DyProbe -Name Native -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)]
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

[StructLayout(LayoutKind.Sequential)]
public struct POINT { public int X; public int Y; }

[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
[DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT lpRect);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT lpPoint);
[DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT val, int size);
'@

function Get-Frame([IntPtr]$h) {
    # DWMWA_EXTENDED_FRAME_BOUNDS = 9，不含窗口阴影，比 GetWindowRect 更准
    $r = New-Object DyProbe.Native+RECT
    $hr = [DyProbe.Native]::DwmGetWindowAttribute($h, 9, [ref]$r, 16)
    if ($hr -ne 0) {
        [void][DyProbe.Native]::GetWindowRect($h, [ref]$r)
    }
    return $r
}

param([switch]$Once)

$foreCache = [IntPtr]::Zero
while ($true) {
    $proc = Get-Process -Name 'douyin' -ErrorAction SilentlyContinue |
            Where-Object { $_.MainWindowHandle -ne 0 } |
            Select-Object -First 1

    if ($null -eq $proc) {
        Write-Output '{"found":false}'
    } else {
        $h = [IntPtr]$proc.MainWindowHandle
        $r = Get-Frame $h
        $w = $r.Right - $r.Left
        $hh = $r.Bottom - $r.Top
        $vis = [DyProbe.Native]::IsWindowVisible($h)
        $min = [DyProbe.Native]::IsIconic($h)
        $fg = [DyProbe.Native]::GetForegroundWindow()
        $obj = [ordered]@{
            found    = $true
            hwnd     = $h.ToInt64()
            x        = $r.Left
            y        = $r.Top
            w        = $w
            h        = $hh
            visible  = [bool]$vis
            minimized = [bool]$min
            focus    = ($fg -eq $h)
        }
        Write-Output ($obj | ConvertTo-Json -Compress)
    }
    if ($Once) { break }
    Start-Sleep -Milliseconds 350
}

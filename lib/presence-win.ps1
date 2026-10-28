# agentbus presence probe (windows). long-lived: prints one JSON line per line read on stdin.
# reads input idle time, the shell's notification state (d3d fullscreen / presentation / busy) and
# whether the foreground window covers its whole monitor (borderless games don't always set d3d state).
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AgentbusPresence {
  [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)] struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  [DllImport("kernel32.dll")] static extern ulong GetTickCount64();
  [DllImport("shell32.dll")] static extern int SHQueryUserNotificationState(out int state);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr GetShellWindow();
  [DllImport("user32.dll")] static extern IntPtr GetDesktopWindow();
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Auto)] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  public static ulong IdleMs() {
    var i = new LASTINPUTINFO(); i.cbSize = (uint)Marshal.SizeOf(i);
    if (!GetLastInputInfo(ref i)) return ulong.MaxValue;
    return (GetTickCount64() & 0xFFFFFFFFUL) >= i.dwTime ? (GetTickCount64() & 0xFFFFFFFFUL) - i.dwTime : 0;
  }
  public static int NotificationState() { int s; return SHQueryUserNotificationState(out s) == 0 ? s : -1; }
  public static uint ForegroundPid() { uint pid; var h = GetForegroundWindow(); if (h == IntPtr.Zero) return 0; GetWindowThreadProcessId(h, out pid); return pid; }
  public static bool ForegroundCoversMonitor() {
    var h = GetForegroundWindow();
    // maximized windows overhang the monitor by their frame width; they are not fullscreen.
    if (h == IntPtr.Zero || h == GetShellWindow() || h == GetDesktopWindow() || IsZoomed(h)) return false;
    RECT r; if (!GetWindowRect(h, out r)) return false;
    var mi = new MONITORINFO(); mi.cbSize = Marshal.SizeOf(mi);
    if (!GetMonitorInfo(MonitorFromWindow(h, 2), ref mi)) return false;
    return r.Left <= mi.rcMonitor.Left && r.Top <= mi.rcMonitor.Top && r.Right >= mi.rcMonitor.Right && r.Bottom >= mi.rcMonitor.Bottom;
  }
}
'@
while ($null -ne [Console]::In.ReadLine()) {
  try {
    $fgPid = [AgentbusPresence]::ForegroundPid()
    $fgName = $null
    if ($fgPid) { try { $fgName = (Get-Process -Id $fgPid).ProcessName } catch {} }
    [Console]::Out.WriteLine((@{
      ok = $true
      idleMs = [AgentbusPresence]::IdleMs()
      notificationState = [AgentbusPresence]::NotificationState()
      foregroundCoversMonitor = [AgentbusPresence]::ForegroundCoversMonitor()
      foreground = $fgName
      foregroundPid = $fgPid
      # wsl2 vm up? (nat mode leaves no lan fingerprint; ~6ms in-process, no wsl.exe spawn)
      wsl = ([System.Diagnostics.Process]::GetProcessesByName('vmmemWSL').Length -gt 0)
      observedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    } | ConvertTo-Json -Compress))
  } catch { [Console]::Out.WriteLine((@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress)) }
  [Console]::Out.Flush()
}

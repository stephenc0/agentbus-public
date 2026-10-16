# agentbus codex writer-lock owners (windows). one shot: prints one JSON line.
# read-only: asks the Restart Manager which processes hold each lock file open. it never opens,
# locks or deletes a lock, so it cannot race codex's own LockFileEx. a lock file with no holder is
# stale (codex leaves the file behind when the owner exits), so existence alone is not liveness.
param([Parameter(Mandatory = $true)][string]$LockDir, [int]$MaxLocks = 512)
$ErrorActionPreference = 'Stop'
try {
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class AgentbusCodexLocks {
  [StructLayout(LayoutKind.Sequential)] struct RM_UNIQUE_PROCESS { public int dwProcessId; public uint StartLow; public uint StartHigh; } // FILETIME: 4-byte aligned
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
    public int ApplicationType; public int AppStatus; public int TSSessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmStartSession(out uint h, int flags, string key);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint h);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmRegisterResources(uint h, uint nFiles, string[] files, uint nApps, IntPtr apps, uint nSvc, string[] svcs);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint h, out uint needed, ref uint count, [In, Out] RM_PROCESS_INFO[] info, ref uint reasons);
  // returns "pid:starttime" pairs; throws on rm failure so the caller reports ok=false instead of "no owner".
  public static string[] Holders(string path) {
    uint h; int rc = RmStartSession(out h, 0, Guid.NewGuid().ToString("N"));
    if (rc != 0) throw new Exception("RmStartSession " + rc);
    try {
      rc = RmRegisterResources(h, 1, new[] { path }, 0, IntPtr.Zero, 0, null);
      if (rc != 0) throw new Exception("RmRegisterResources " + rc);
      for (int attempt = 0; attempt < 3; attempt++) {
        uint needed = 0, count = 0, reasons = 0;
        rc = RmGetList(h, out needed, ref count, null, ref reasons);
        if (rc == 0) return new string[0];
        if (rc != 234) throw new Exception("RmGetList " + rc); // ERROR_MORE_DATA
        var info = new RM_PROCESS_INFO[needed]; count = needed;
        rc = RmGetList(h, out needed, ref count, info, ref reasons);
        if (rc == 234) continue; // holder set grew between calls
        if (rc != 0) throw new Exception("RmGetList " + rc);
        var res = new List<string>();
        for (int i = 0; i < count; i++) res.Add(info[i].Process.dwProcessId + ":" + (((ulong)info[i].Process.StartHigh << 32) | info[i].Process.StartLow));
        return res.ToArray();
      }
      throw new Exception("RmGetList unstable");
    } finally { RmEndSession(h); }
  }
}
'@
  $out = [ordered]@{ ok = $true; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); truncated = $false; locks = [ordered]@{}; processes = [ordered]@{} }
  if (-not (Test-Path -LiteralPath $LockDir -PathType Container)) { $out.missingDir = $true; [Console]::Out.WriteLine(($out | ConvertTo-Json -Compress -Depth 6)); exit 0 }
  $files = @(Get-ChildItem -LiteralPath $LockDir -File -Filter '*.lock' | Where-Object { $_.Name -match '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.lock$' } | Sort-Object LastWriteTimeUtc -Descending)
  if ($files.Count -gt $MaxLocks) { $out.truncated = $true; $files = $files[0..($MaxLocks - 1)] }
  $pids = @{}
  foreach ($f in $files) {
    $id = $f.Name.Substring(0, $f.Name.Length - 5)
    try { $holders = [AgentbusCodexLocks]::Holders($f.FullName); $out.locks[$id] = @{ holders = @($holders) } }
    catch { $out.locks[$id] = @{ error = $_.Exception.Message } ; continue }
    foreach ($h in $holders) { $pids[[int]($h.Split(':')[0])] = $true }
  }
  if ($pids.Count) {
    $filter = ($pids.Keys | ForEach-Object { "ProcessId=$_" }) -join ' OR '
    $procs = @(Get-CimInstance Win32_Process -Filter $filter)
    $parentIds = @($procs | ForEach-Object { $_.ParentProcessId } | Sort-Object -Unique)
    $parents = @{}
    if ($parentIds.Count) { foreach ($p in @(Get-CimInstance Win32_Process -Filter (($parentIds | ForEach-Object { "ProcessId=$_" }) -join ' OR '))) { $parents[[int]$p.ProcessId] = $p } }
    foreach ($p in $procs) {
      $parent = $parents[[int]$p.ParentProcessId]
      $start = $null; try { $start = [Diagnostics.Process]::GetProcessById([int]$p.ProcessId).StartTime.ToFileTimeUtc() } catch {}
      # start time from Process (exact 100ns); wmi CreationDate is only 1us and would never match RM
      $out.processes["$($p.ProcessId)"] = [ordered]@{
        image = $p.Name; path = $p.ExecutablePath
        startTime = if ($null -ne $start) { [string]$start } else { $null } # string: FILETIME exceeds 2^53
        parentPid = $p.ParentProcessId; parentImage = if ($parent) { $parent.Name } else { $null }; parentPath = if ($parent) { $parent.ExecutablePath } else { $null }
        appServer = [bool]($p.CommandLine -match '(^|\s)app-server(\s|$)'); listen = if ($p.CommandLine -match '--listen\s+(\S+)') { $Matches[1] } else { $null }
      }
    }
  }
  [Console]::Out.WriteLine(($out | ConvertTo-Json -Compress -Depth 6))
} catch {
  [Console]::Out.WriteLine((@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress))
}

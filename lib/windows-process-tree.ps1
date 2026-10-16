# Terminates and certifies an owned Windows process tree without relying on
# taskkill exit codes or localized output. Identity is (pid, creation time):
# a process is a descendant only if its parent pid is a captured identity and it
# was created at or after that parent. Every captured process is pinned by an
# open process handle before its identity is read, so its pid cannot be reused
# while this script runs. Output: exactly one JSON line. Exit 0 only when every
# captured identity has exited and a final rescan finds no live descendant.
param(
  [Parameter(Mandatory = $true)][int]$LeaderPid,
  # The node supervisor that spawned the leader and still holds its handle.
  [Parameter(Mandatory = $true)][int]$SupervisorPid,
  [ValidateSet('kill', 'snapshot')][string]$Mode = 'kill',
  [int]$TimeoutMs = 5000,
  [int]$MaxRounds = 20
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

function Out-Result($ok, $fields) {
  $fields['ok'] = $ok
  [Console]::Out.WriteLine(($fields | ConvertTo-Json -Compress -Depth 5))
  exit ([int](-not $ok))
}
# CIM CreationDate has microsecond precision; native start time has 100ns.
# Compare at microsecond granularity exactly; no tolerance window.
# Integer division only: ticks exceed 2^53, so a double quotient is inexact.
function Get-Micros([long]$ticks) { $rem = [long]0; return [Math]::DivRem($ticks, [long]10, [ref]$rem) }
function Get-Table {
  # One consistent snapshot: pid -> @{ parent; micros }.
  $table = @{}
  foreach ($p in Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId, CreationDate) {
    if ($null -eq $p.CreationDate) { continue } # System Idle / protected
    $table[[int]$p.ProcessId] = @{ parent = [int]$p.ParentProcessId; micros = Get-Micros $p.CreationDate.ToUniversalTime().Ticks }
  }
  return $table
}

$captured = @{}   # pid -> @{ micros; handle }
$unopenable = @{} # pid -> reason: live descendants we could not pin
function Add-Identity([int]$procId, [long]$micros) {
  if ($captured.ContainsKey($procId)) { return $true }
  try {
    $h = [System.Diagnostics.Process]::GetProcessById($procId)
    # Pin first: Process.Handle opens and retains a real process handle.
    [void]$h.Handle
    $start = Get-Micros $h.StartTime.ToUniversalTime().Ticks
  } catch [System.ArgumentException] { return $false } # already gone
  catch { $unopenable[$procId] = $_.Exception.GetType().Name; return $false }
  if ($start -ne $micros) { $h.Dispose(); return $false } # pid reused since snapshot
  $captured[$procId] = @{ micros = $start; handle = $h }
  return $true
}

# Leader: must be live, pinned, a child of the supervisor, and not older than it.
$table = Get-Table
if (-not $table.ContainsKey($LeaderPid) -or -not $table.ContainsKey($SupervisorPid)) {
  Out-Result $false @{ error = 'leader or supervisor is not running; descendant ownership cannot be proven'; leaderPid = $LeaderPid }
}
$lead = $table[$LeaderPid]
if ($lead.parent -ne $SupervisorPid -or $lead.micros -lt $table[$SupervisorPid].micros -or -not (Add-Identity $LeaderPid $lead.micros)) {
  Out-Result $false @{ error = 'leader identity does not match the supervisor'; leaderPid = $LeaderPid }
}

function Expand($table) {
  # Breadth first from every pinned identity, including exited ones: a pinned
  # pid cannot be reused, so links to it remain valid after it exits.
  $queue = New-Object System.Collections.Queue
  foreach ($kv in @($captured.GetEnumerator())) { $queue.Enqueue(@{ pid = $kv.Key; micros = $kv.Value.micros }) }
  $seen = @{}; $added = 0
  while ($queue.Count) {
    $n = $queue.Dequeue()
    if ($seen.ContainsKey($n.pid)) { continue }
    $seen[$n.pid] = $true
    foreach ($kv in @($table.GetEnumerator())) {
      $c = $kv.Value
      if ($kv.Key -eq $n.pid -or $c.parent -ne $n.pid -or $c.micros -lt $n.micros) { continue }
      $isNew = -not $captured.ContainsKey($kv.Key)
      if (Add-Identity $kv.Key $c.micros) {
        if ($isNew) { $added++ }
        $queue.Enqueue(@{ pid = $kv.Key; micros = $c.micros })
      }
    }
  }
  return $added
}

[void](Expand $table)
if ($Mode -eq 'snapshot') {
  $result = @{ leaderPid = $LeaderPid; captured = @($captured.Keys | Sort-Object); unopenable = $unopenable }
  foreach ($c in $captured.Values) { $c.handle.Dispose() }
  Out-Result $true $result
}

$deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
$rounds = 0
do {
  $rounds++
  # Leader first so it cannot respawn children, then every other pinned process.
  $order = @($captured.Keys | Sort-Object { if ($_ -eq $LeaderPid) { 0 } else { 1 } })
  foreach ($procId in $order) {
    $h = $captured[$procId].handle
    if (-not $h.HasExited) { try { $h.Kill() } catch [System.InvalidOperationException] { } catch [System.ComponentModel.Win32Exception] { } }
  }
  foreach ($procId in $order) {
    $left = [int][Math]::Max(0, ($deadline - [DateTime]::UtcNow).TotalMilliseconds)
    [void]$captured[$procId].handle.WaitForExit($left)
  }
  # Late forks: rescan from pinned identities until nothing new appears.
  $added = Expand (Get-Table)
} while ($added -gt 0 -and $rounds -lt $MaxRounds -and [DateTime]::UtcNow -lt $deadline)

$survivors = @($captured.GetEnumerator() | Where-Object { -not $_.Value.handle.HasExited } | ForEach-Object { $_.Key } | Sort-Object)
$final = Get-Table
$liveUnpinned = @($unopenable.Keys | Where-Object { $final.ContainsKey($_) } | Sort-Object)
$result = @{ leaderPid = $LeaderPid; rounds = $rounds; killed = @($captured.Keys | Sort-Object); survivors = $survivors; unopenable = $unopenable }
foreach ($c in $captured.Values) { $c.handle.Dispose() }
if ($survivors.Count -or $liveUnpinned.Count -or $added -gt 0) {
  $result['error'] = 'owned process tree termination is unconfirmed'
  Out-Result $false $result
}
Out-Result $true $result

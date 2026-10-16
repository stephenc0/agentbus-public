param()
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
# Read path data from stdin, never interpolate it as PowerShell source.
$raw = [Console]::In.ReadToEnd()
if ($raw.Length -gt 262144) { throw 'ACL request too large' }
$paths = @((ConvertFrom-Json $raw))
if ($paths.Count -gt 128) { throw 'too many ACL paths' }
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$localAdminSid = $null
if ($sid -match '^S-1-5-21-\d+-\d+-\d+-500$') {
  $localAdminSid = ([System.Security.AccessControl.RawSecurityDescriptor]::new('D:(A;;FA;;;LA)')).DiscretionaryAcl[0].SecurityIdentifier.Value
}
$results = @()
foreach ($p in $paths) {
  try {
    if ($p -isnot [string] -or -not [System.IO.Path]::IsPathRooted($p)) { throw 'invalid path' }
    # A pwsh 7 parent can export PSModulePath entries whose Security module
    # cannot load in Windows PowerShell 5.1. Read the DACL via .NET directly;
    # never depend on module autoload or modify the caller's environment.
    $acl = [System.IO.File]::GetAccessControl($p, [System.Security.AccessControl.AccessControlSections]::Access)
    $sddl = $acl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access)
    $results += @{ path = $p; sddl = $sddl }
  } catch { $results += @{ path = $p; error = 'ACL unavailable' } }
}
@{ sid = $sid; localAdminSid = $localAdminSid; results = $results } | ConvertTo-Json -Compress -Depth 4

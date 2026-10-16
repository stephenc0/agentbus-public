param([Parameter(Mandatory=$true)][string]$LiteralPath, [Parameter(Mandatory=$true)][string]$Sid)
$ErrorActionPreference = 'Stop'
if ($Sid -notmatch '^S-1-[0-9-]+$') { throw 'invalid owner SID' }
$target = Get-Item -LiteralPath $LiteralPath -Force
# Set only access rules. icacls /restore tries to enable restoration privileges
# unavailable to a normal user, even for a file the user owns.
if ($target.PSIsContainer) {
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetSecurityDescriptorSddlForm("D:P(A;OICI;FA;;;$Sid)", [System.Security.AccessControl.AccessControlSections]::Access)
  [System.IO.Directory]::SetAccessControl($target.FullName, $acl)
} else {
  $acl = New-Object System.Security.AccessControl.FileSecurity
  $acl.SetSecurityDescriptorSddlForm("D:P(A;;FA;;;$Sid)", [System.Security.AccessControl.AccessControlSections]::Access)
  [System.IO.File]::SetAccessControl($target.FullName, $acl)
}

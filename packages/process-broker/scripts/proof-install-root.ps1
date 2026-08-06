<#
.SYNOPSIS
  Stage 17 bounded proof: create ONE administrator-protected, immutable install
  root and place ONE verified artifact closure inside it.

.DESCRIPTION
  This is the only elevated install transaction the Stage 17 bounded
  installed-artifact proof is permitted to perform. It is deliberately narrow.

  It will ONLY:
    - resolve the real CommonApplicationData folder (not the %ProgramData%
      string, which an attacker or a mistake could redirect);
    - create exactly C:\ProgramData\AI-Dev-OS\Stage17-Proof\<run-token>;
    - disable ACL inheritance on the created version tree and grant
      FullControl to SYSTEM and BUILTIN\Administrators, and ReadAndExecute
      only to the named unelevated proof identity;
    - copy exactly the files named by the supplied manifest, verifying each
      SHA-256 before and after the copy;
    - re-verify the resulting owner and DACL and emit a JSON result.

  It will NOT: modify an existing parent's ACL or contents; delete anything
  outside the leaf it created; modify machine policy, services, scheduled tasks,
  firewall state, PATH, or package state; follow a reparse point; overwrite an
  existing leaf; or accept a destination outside the validated leaf.

  It MAY create the shared AI-Dev-OS\Stage17-Proof parent chain when absent, and
  it verifies the ownership and access control of every ancestor before and
  after doing so. An earlier revision of this file claimed it would never touch
  the parent while unconditionally creating it with -Force; that contradiction
  was found by audit and is corrected here.

  Every failure is fail-closed: the script stops, and (unless -NoRollback) it
  removes the partial leaf it created so no half-installed root survives.

.NOTES
  ****  NOT YET APPROVED FOR ELEVATED EXECUTION.  ****

  An independent audit found, and direct measurement on the target host
  confirmed, that C:\ProgramData grants BUILTIN\Users (CI)(WD,AD) and
  CREATOR OWNER (OI)(CI)(IO)(F). An unelevated process can therefore create
  C:\ProgramData\AI-Dev-OS, become its owner with FullControl, and thereby both
  pre-plant a directory junction and hold FILE_DELETE_CHILD over any "protected"
  leaf inside it -- which would let it delete or rename that leaf regardless of
  the leaf's own DACL.

  This revision adds ancestry verification that refuses in those conditions, so
  the common attack is now detected rather than walked into. A residual
  check-to-use race remains that PowerShell cannot close: verification is by
  path, not by handle. Closing it requires opening each ancestor with
  FILE_FLAG_OPEN_REPARSE_POINT and creating the leaf relative to that handle,
  which needs a native implementation.

  Until that exists, this script must not be run elevated on a host where an
  untrusted local process could be active.

  Run elevated only after the above is resolved. Nothing else in this proof
  runs elevated.
#>
#requires -Version 7.0
[CmdletBinding()]
param(
    # 32 lowercase hex characters. Identifies exactly one proof run.
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-f0-9]{32}$')]
    [string] $RunToken,

    # Absolute path to the artifact manifest describing the closure to install.
    [Parameter(Mandatory = $true)]
    [string] $ManifestPath,

    # Absolute path to the directory holding the built closure.
    [Parameter(Mandatory = $true)]
    [string] $SourceDirectory,

    # Component name; must match the manifest.
    [Parameter(Mandatory = $true)]
    [ValidateSet('windows-supervisor', 'windows-helper')]
    [string] $Component,

    # DOMAIN\user that will run the unelevated proof. Receives ReadAndExecute.
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[^\\/:*?"<>|]+\\[^\\/:*?"<>|]+$')]
    [string] $ProofIdentity,

    # Emit the plan and exit without creating anything.
    [switch] $WhatIfOnly,

    # Leave a partial leaf in place on failure (diagnostics only).
    [switch] $NoRollback
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:CreatedLeaf = $null

function Fail {
    param([string] $Code, [string] $Detail)
    if ($script:CreatedLeaf -and -not $NoRollback -and (Test-Path -LiteralPath $script:CreatedLeaf)) {
        try {
            # Recursive, but bounded to the leaf this invocation created and
            # validated. An earlier revision's comment here said
            # "non-recursive-by-intent" directly above a -Recurse flag, which
            # actively misled anyone skimming the rollback for recursion risk.
            Remove-Item -LiteralPath $script:CreatedLeaf -Recurse -Force -ErrorAction Stop
            $rolled = $true
        } catch {
            $rolled = $false
        }
    } else {
        $rolled = $false
    }
    [pscustomobject]@{
        status       = 'failed'
        code         = $Code
        detail       = $Detail
        rolledBack   = $rolled
        createdLeaf  = $script:CreatedLeaf
    } | ConvertTo-Json -Depth 6
    exit 1
}

function Assert-NoReparsePointInChain {
    param([string] $Path)
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                Fail 'reparse-point-in-path' "Reparse point at: $current"
            }
        }
        $parent = [IO.Path]::GetDirectoryName($current)
        if ($parent -eq $current -or [string]::IsNullOrEmpty($parent)) { break }
        $current = $parent
    }
}

# Principals allowed to own, or hold modify-class rights over, any ancestor of
# the install leaf. Anyone else holding them can delete or rename the leaf via
# FILE_DELETE_CHILD on its parent, regardless of the leaf's own DACL.
$script:TrustedSids = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')

<#
  The rights that let an untrusted principal remove, rename, or re-permission
  the protected leaf. Deliberately NOT the whole write class.

  Windows grants BUILTIN\Users WriteData/AppendData on C:\ProgramData and
  Authenticated Users CreateDirectories on C:\ by default. Those let a user
  create *new siblings*; they do not let anyone touch an existing leaf. Treating
  them as disqualifying would make the check refuse on every stock Windows
  install, which is a check nobody can satisfy and therefore a check everybody
  disables.

  What actually breaks the immutability property is Delete on an ancestor,
  DeleteSubdirectoriesAndFiles (FILE_DELETE_CHILD) on the parent, or
  ChangePermissions/TakeOwnership anywhere on the chain -- and ownership itself,
  because an owner can always rewrite the DACL. Those are checked.
#>
$script:LeafControlRights =
    [Security.AccessControl.FileSystemRights]::Delete -bor
    [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
    [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
    [Security.AccessControl.FileSystemRights]::TakeOwnership

# Get-Acl returns Owner as a String and Access[].IdentityReference as an
# IdentityReference. Accepting only the latter made the ancestry check throw a
# parameter-binding error on its very first call instead of returning a verdict.
function Test-TrustedPrincipal {
    param([object] $Identity)
    if ($null -eq $Identity) { return $false }
    try {
        $sid = if ($Identity -is [Security.Principal.SecurityIdentifier]) { $Identity }
               elseif ($Identity -is [Security.Principal.IdentityReference]) { $Identity.Translate([Security.Principal.SecurityIdentifier]) }
               else { (New-Object Security.Principal.NTAccount([string]$Identity)).Translate([Security.Principal.SecurityIdentifier]) }
    } catch { return $false }
    return $script:TrustedSids -contains $sid.Value
}

<#
  Verifies that every ancestor from the volume root down to $Path is owned by a
  trusted principal and grants modify-class rights to nobody else.

  This is the check whose absence the audit flagged: the leaf's own DACL cannot
  make it immutable if an untrusted principal owns or can write to its parent.
#>
function Assert-ProtectedAncestry {
    param([string] $Path, [string] $Stage)
    $chain = @()
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        $chain += $current
        $parent = [IO.Path]::GetDirectoryName($current)
        if ($parent -eq $current -or [string]::IsNullOrEmpty($parent)) { break }
        $current = $parent
    }

    foreach ($component in $chain) {
        if (-not (Test-Path -LiteralPath $component)) { continue }

        $item = Get-Item -LiteralPath $component -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            Fail 'ancestor-reparse-point' "[$Stage] reparse point at $component"
        }

        $acl = Get-Acl -LiteralPath $component
        if (-not (Test-TrustedPrincipal $acl.Owner)) {
            Fail 'ancestor-untrusted-owner' "[$Stage] $component is owned by $($acl.Owner)"
        }
        foreach ($ace in $acl.Access) {
            if ($ace.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { continue }
            # InheritOnly ACEs grant nothing on this object; they describe what
            # future children inherit. Every child on our chain is itself walked
            # and checked on its own merits, so counting an InheritOnly ACE here
            # would refuse on stock Windows: C:\ carries an inherit-only
            # Authenticated Users Modify ACE (0xE0010000, which includes Delete)
            # that confers no access to C:\ itself, and C:\ProgramData does not
            # inherit it.
            if (($ace.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
            if (($ace.FileSystemRights -band $script:LeafControlRights) -eq 0) { continue }
            if (Test-TrustedPrincipal $ace.IdentityReference) { continue }
            Fail 'ancestor-untrusted-control' (
                "[$Stage] $component grants $($ace.FileSystemRights) to $($ace.IdentityReference)")
        }
    }
}

# --- 1. Elevation -----------------------------------------------------------
# -WhatIfOnly is deliberately allowed unelevated: its entire purpose is to let
# a reviewer see exactly what a UAC prompt would authorize, before granting it.
# It creates nothing. Every mutating path below still requires elevation.
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$isElevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isElevated -and -not $WhatIfOnly) {
    Fail 'not-elevated' 'This install transaction requires an elevated session.'
}

# --- 2. Resolve the real ProgramData and build the exact leaf ---------------
$commonAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
if ([string]::IsNullOrWhiteSpace($commonAppData)) {
    Fail 'programdata-unresolved' 'CommonApplicationData did not resolve.'
}
$expectedParent = [IO.Path]::GetFullPath((Join-Path $commonAppData 'AI-Dev-OS\Stage17-Proof'))
$leaf           = [IO.Path]::GetFullPath((Join-Path $expectedParent $RunToken))
$versionDir     = Join-Path $leaf $Component

# The leaf must be a direct child of the expected parent. No traversal, no alias.
if ([IO.Path]::GetDirectoryName($leaf) -ne $expectedParent) {
    Fail 'leaf-outside-parent' "Leaf $leaf is not a direct child of $expectedParent"
}
if ((Split-Path $leaf -Leaf) -ne $RunToken) {
    Fail 'leaf-name-mismatch' 'Leaf name does not equal the run token.'
}
if ($leaf -match '~') {
    Fail 'leaf-short-name' 'Leaf path contains a tilde (possible 8.3 alias).'
}

Assert-NoReparsePointInChain -Path $expectedParent

if (Test-Path -LiteralPath $leaf) {
    Fail 'leaf-already-exists' "Refusing to reuse or overwrite an existing leaf: $leaf"
}

# --- 3. Validate inputs -----------------------------------------------------
if (-not [IO.Path]::IsPathRooted($ManifestPath)) { Fail 'manifest-not-absolute' $ManifestPath }
if (-not [IO.Path]::IsPathRooted($SourceDirectory)) { Fail 'source-not-absolute' $SourceDirectory }
if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) { Fail 'manifest-missing' $ManifestPath }
if (-not (Test-Path -LiteralPath $SourceDirectory -PathType Container)) { Fail 'source-missing' $SourceDirectory }
Assert-NoReparsePointInChain -Path $SourceDirectory

try {
    $manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
    Fail 'manifest-unparsable' $_.Exception.Message
}
foreach ($required in @('component', 'files', 'signerState')) {
    if (-not ($manifest.PSObject.Properties.Name -contains $required)) {
        Fail 'manifest-field-missing' $required
    }
}
if ($manifest.component -ne $Component) { Fail 'manifest-component-mismatch' "$($manifest.component) != $Component" }
if ($manifest.signerState -ne 'unsigned-candidate') { Fail 'manifest-signer-unexpected' $manifest.signerState }
if (@($manifest.files).Count -lt 1) { Fail 'manifest-empty-closure' 'No files listed.' }

try {
    $proofSid = (New-Object Security.Principal.NTAccount($ProofIdentity)).Translate([Security.Principal.SecurityIdentifier])
} catch {
    Fail 'proof-identity-unresolved' $ProofIdentity
}

$plan = [pscustomobject]@{
    status          = 'planned'
    programData     = $commonAppData
    expectedParent  = $expectedParent
    leaf            = $leaf
    versionDir      = $versionDir
    component       = $Component
    fileCount       = @($manifest.files).Count
    proofIdentity   = $ProofIdentity
    proofSid        = $proofSid.Value
    aclPlan         = @(
        'BREAK inheritance, remove inherited ACEs',
        'NT AUTHORITY\SYSTEM            : FullControl (ContainerInherit, ObjectInherit)',
        'BUILTIN\Administrators         : FullControl (ContainerInherit, ObjectInherit)',
        ("{0} : ReadAndExecute (ContainerInherit, ObjectInherit)" -f $ProofIdentity)
    )
}

if ($WhatIfOnly) {
    $plan | ConvertTo-Json -Depth 6
    exit 0
}

# --- 4. Create the leaf -----------------------------------------------------
# Verify the ancestry BEFORE creating anything. A pre-planted junction or an
# untrusted-owned parent is refused here rather than walked into.
Assert-ProtectedAncestry -Path $expectedParent -Stage 'pre-create'

try {
    New-Item -ItemType Directory -Path $expectedParent -Force -ErrorAction Stop | Out-Null
} catch {
    Fail 'parent-create-failed' $_.Exception.Message
}

# Re-verify AFTER creating the chain. New-Item -Force silently returns an
# existing junction, so the pre-create check alone is not sufficient: this is
# the second half of the audit's finding, and it is why the check runs twice.
Assert-ProtectedAncestry -Path $expectedParent -Stage 'post-create'

try {
    $created = New-Item -ItemType Directory -Path $leaf -ErrorAction Stop
    $script:CreatedLeaf = $created.FullName
    New-Item -ItemType Directory -Path $versionDir -ErrorAction Stop | Out-Null
} catch {
    Fail 'leaf-create-failed' $_.Exception.Message
}

# --- 5. Apply the protective DACL BEFORE any content is written -------------
try {
    $acl = Get-Acl -LiteralPath $leaf
    $acl.SetAccessRuleProtection($true, $false)   # break inheritance, drop inherited
    foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRule($rule) }

    $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    $noProp  = [Security.AccessControl.PropagationFlags]::None
    $allow   = [Security.AccessControl.AccessControlType]::Allow

    $systemSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
    $adminsSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')

    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($systemSid, 'FullControl',   $inherit, $noProp, $allow)))
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($adminsSid, 'FullControl',   $inherit, $noProp, $allow)))
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($proofSid,  'ReadAndExecute', $inherit, $noProp, $allow)))
    $acl.SetOwner($adminsSid)

    Set-Acl -LiteralPath $leaf -AclObject $acl -ErrorAction Stop
} catch {
    Fail 'acl-apply-failed' $_.Exception.Message
}

# --- 6. Copy the exact closure, verifying each file -------------------------
# Everything from here to the end is inside one try/catch. Previously steps 6
# and 7 had no handler at all, so with $ErrorActionPreference='Stop' a disk-full
# condition, a sharing violation or a locked source file terminated the script
# without calling Fail: no rollback ran, a half-populated elevated-owned
# directory survived, and no JSON result was emitted at all.
try {
$installed = @()
foreach ($entry in $manifest.files) {
    foreach ($f in @('name', 'size', 'sha256')) {
        if (-not ($entry.PSObject.Properties.Name -contains $f)) { Fail 'manifest-file-field-missing' $f }
    }
    # Mirror of ArtifactManifestReader.IsAcceptableFileName. The elevated script
    # must not be the weakest validator in the chain; the previous four-clause
    # check accepted reserved device stems, alternate-data-stream syntax,
    # trailing dots and spaces, control characters, and wildcards.
    $name = [string]$entry.name
    $reserved = @('CON','PRN','AUX','NUL','COM1','COM2','COM3','COM4','COM5','COM6','COM7','COM8','COM9',
                  'LPT1','LPT2','LPT3','LPT4','LPT5','LPT6','LPT7','LPT8','LPT9')
    $stem = ($name -split '\.')[0]
    if ($name.Length -lt 1 -or $name.Length -gt 128) { Fail 'manifest-file-name-unsafe' "$name (length)" }
    if ($name -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { Fail 'manifest-file-name-unsafe' "$name (charset)" }
    if ($name -match '\.\.') { Fail 'manifest-file-name-unsafe' "$name (dot-dot)" }
    if ($name.EndsWith('.') -or $name.EndsWith(' ')) { Fail 'manifest-file-name-unsafe' "$name (trailing)" }
    if ($reserved -contains $stem.ToUpperInvariant()) { Fail 'manifest-file-name-unsafe' "$name (reserved device)" }
    $src = Join-Path $SourceDirectory $name
    $dst = Join-Path $versionDir $name
    if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($dst)) -ne [IO.Path]::GetFullPath($versionDir)) {
        Fail 'destination-escape' $dst
    }
    if (-not (Test-Path -LiteralPath $src -PathType Leaf)) { Fail 'source-file-missing' $src }

    $srcItem = Get-Item -LiteralPath $src -Force
    if ($srcItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { Fail 'source-file-reparse' $src }
    if ($srcItem.Length -ne [int64]$entry.size) { Fail 'source-size-mismatch' "$name expected $($entry.size) got $($srcItem.Length)" }

    $srcHash = (Get-FileHash -LiteralPath $src -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($srcHash -ne ([string]$entry.sha256).ToLowerInvariant()) { Fail 'source-digest-mismatch' $name }

    Copy-Item -LiteralPath $src -Destination $dst -ErrorAction Stop

    $dstHash = (Get-FileHash -LiteralPath $dst -Algorithm SHA256).Hash.ToLowerInvariant()
    $dstSize = (Get-Item -LiteralPath $dst -Force).Length
    if ($dstHash -ne $srcHash) { Fail 'installed-digest-mismatch' $name }
    if ($dstSize -ne [int64]$entry.size) { Fail 'installed-size-mismatch' $name }

    $installed += [pscustomobject]@{ name = $name; size = $dstSize; sha256 = $dstHash }
}

# Copy the manifest itself last, so an interrupted install has no manifest.
$manifestDst = Join-Path $versionDir 'artifact-manifest.json'
Copy-Item -LiteralPath $ManifestPath -Destination $manifestDst -ErrorAction Stop

# Refuse any unexpected extra file in the installed closure.
# Ordinal comparison: -notcontains is case-insensitive, which would accept a
# case-only duplicate that the reviewed C# closed class refuses.
$expectedNames = [Collections.Generic.HashSet[string]]::new(
    ([string[]](@($installed.name) + @('artifact-manifest.json'))), [StringComparer]::Ordinal)
$actualNames = @(Get-ChildItem -LiteralPath $versionDir -Force -File | Select-Object -ExpandProperty Name)
$extra = @($actualNames | Where-Object { -not $expectedNames.Contains($_) })
if ($extra.Count -gt 0) { Fail 'unexpected-installed-file' ($extra -join ', ') }

# --- 7. Verify the resulting protection -------------------------------------
$finalAcl = Get-Acl -LiteralPath $leaf
$aceSummary = @($finalAcl.Access | ForEach-Object {
    "{0}={1}{2}" -f $_.IdentityReference, $_.FileSystemRights, $(if ($_.IsInherited) { '(inherited)' } else { '' })
})
$anyInherited = @($finalAcl.Access | Where-Object { $_.IsInherited }).Count -gt 0

# Modify-class, not FileSystemRights::Write. Write is 0x116 and misses Delete
# (0x10000), WriteDAC, WriteOwner and ChangePermissions, so the previous check
# would have reported proofIdentityWritable=false for an ACE granting Delete.
$proofWritable = @($finalAcl.Access | Where-Object {
    $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
    $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq $proofSid.Value -and
    ($_.FileSystemRights -band $script:LeafControlRights) -ne 0
}).Count -gt 0

# These were previously computed, printed, and never checked: the script
# reported status 'installed' no matter what the resulting protection was.
if ($anyInherited) { Fail 'leaf-inherited-ace-present' ($aceSummary -join ' | ') }
if ($proofWritable) { Fail 'leaf-writable-by-proof-identity' ($aceSummary -join ' | ') }
if (-not (Test-TrustedPrincipal $finalAcl.Owner)) { Fail 'leaf-untrusted-owner' $finalAcl.Owner }
if ($finalAcl.Access.Count -ne 3) { Fail 'leaf-unexpected-ace-count' ($aceSummary -join ' | ') }

# Final ancestry re-check: the protection of the leaf is only as good as the
# protection of everything above it, at the moment the caller will use it.
Assert-ProtectedAncestry -Path $expectedParent -Stage 'post-install'

[pscustomobject]@{
    status              = 'installed'
    leaf                = $leaf
    versionDir          = $versionDir
    component           = $Component
    installedFileCount  = $installed.Count
    installedFiles      = $installed
    manifestInstalledAs = $manifestDst
    owner               = $finalAcl.Owner
    inheritanceEnabled  = $anyInherited
    proofIdentityWritable = $proofWritable
    accessControlEntries = $aceSummary
    ancestryVerified     = @('pre-create', 'post-create', 'post-install')
} | ConvertTo-Json -Depth 6

}
catch {
    Fail 'unexpected-failure' $_.Exception.Message
}

<#
.SYNOPSIS
  Stage 17 bounded proof: remove EXACTLY the one protected install leaf created
  by proof-install-root.ps1.

.DESCRIPTION
  This is the only elevated cleanup transaction the proof is permitted to
  perform. It removes exactly

      C:\ProgramData\AI-Dev-OS\Stage17-Proof\<run-token>

  and nothing else.

  It will NOT: delete or modify the shared Stage17-Proof parent; delete the
  AI-Dev-OS folder; accept a path outside the validated leaf; follow a reparse
  point; use a wildcard; or touch policy, services, scheduled tasks, firewall
  state, PATH, package state, or any unrelated ACL.

  It refuses rather than guesses. If the leaf is absent it reports
  'already-absent' and exits 0, so cleanup is idempotent.

.NOTES
  ****  NOT YET APPROVED FOR ELEVATED EXECUTION.  ****

  See proof-install-root.ps1 for the full reasoning. In short: a residual
  check-to-use race remains that PowerShell cannot close, because verification
  is by path rather than by handle.

  This revision adds the ancestor reparse check that was missing entirely --
  the previous version checked the leaf and its contents but never its parents,
  so a junction planted at Stage17-Proof would have been followed silently and
  Remove-Item -Recurse would have operated at the junction's target.

  #requires -Version 7.0 is present deliberately: under Windows PowerShell 5.1,
  which is the default handler for a right-click "Run as administrator",
  Remove-Item -Recurse on a junction has historically deleted the target's
  contents rather than the link.

  Run elevated only after the residual race is resolved. Nothing else in this
  proof runs elevated.
#>
#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-f0-9]{32}$')]
    [string] $RunToken,

    [switch] $WhatIfOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Fail {
    param([string] $Code, [string] $Detail)
    [pscustomobject]@{ status = 'failed'; code = $Code; detail = $Detail } | ConvertTo-Json -Depth 4
    exit 1
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Fail 'not-elevated' 'This cleanup transaction requires an elevated session.'
}

$commonAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
if ([string]::IsNullOrWhiteSpace($commonAppData)) { Fail 'programdata-unresolved' 'CommonApplicationData did not resolve.' }

$expectedParent = [IO.Path]::GetFullPath((Join-Path $commonAppData 'AI-Dev-OS\Stage17-Proof'))
$leaf           = [IO.Path]::GetFullPath((Join-Path $expectedParent $RunToken))

# The leaf must be a direct child of the expected parent, named exactly the token.
if ([IO.Path]::GetDirectoryName($leaf) -ne $expectedParent) { Fail 'leaf-outside-parent' $leaf }
if ((Split-Path $leaf -Leaf) -ne $RunToken) { Fail 'leaf-name-mismatch' $leaf }
if ($leaf -match '~') { Fail 'leaf-short-name' $leaf }
if ($leaf -eq $expectedParent) { Fail 'refuse-parent-removal' $leaf }

# Ancestor reparse check. Its absence was the whole of audit finding F8: a
# junction planted at AI-Dev-OS or Stage17-Proof would be followed silently and
# the recursive removal would operate at the junction's target.
$chain = @()
$walk = $expectedParent
while ($walk) {
    $chain += $walk
    $up = [IO.Path]::GetDirectoryName($walk)
    if ($up -eq $walk -or [string]::IsNullOrEmpty($up)) { break }
    $walk = $up
}
foreach ($component in $chain) {
    if (-not (Test-Path -LiteralPath $component)) { continue }
    $item = Get-Item -LiteralPath $component -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        Fail 'ancestor-reparse-point' $component
    }
}

if (-not (Test-Path -LiteralPath $leaf)) {
    [pscustomobject]@{ status = 'already-absent'; leaf = $leaf } | ConvertTo-Json -Depth 4
    exit 0
}

$leafItem = Get-Item -LiteralPath $leaf -Force
if ($leafItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { Fail 'leaf-is-reparse-point' $leaf }
if (-not $leafItem.PSIsContainer) { Fail 'leaf-not-a-directory' $leaf }

$inventory = @(Get-ChildItem -LiteralPath $leaf -Recurse -Force | ForEach-Object {
    [pscustomobject]@{
        path     = $_.FullName.Substring($leaf.Length).TrimStart('\')
        type     = if ($_.PSIsContainer) { 'dir' } else { 'file' }
        reparse  = [bool]($_.Attributes -band [IO.FileAttributes]::ReparsePoint)
    }
})

# A reparse point anywhere inside would let recursive removal escape the leaf.
$innerReparse = @($inventory | Where-Object { $_.reparse })
if ($innerReparse.Count -gt 0) {
    Fail 'reparse-point-inside-leaf' (($innerReparse | ForEach-Object { $_.path }) -join ', ')
}

if ($WhatIfOnly) {
    [pscustomobject]@{
        status    = 'planned'
        leaf      = $leaf
        entries   = $inventory.Count
        inventory = $inventory
    } | ConvertTo-Json -Depth 6
    exit 0
}

try {
    Remove-Item -LiteralPath $leaf -Recurse -Force -ErrorAction Stop
} catch {
    Fail 'leaf-remove-failed' $_.Exception.Message
}

$leafGone   = -not (Test-Path -LiteralPath $leaf)
$parentKept = Test-Path -LiteralPath $expectedParent

# Report, never remove, any sibling leaf: it is not ours to delete.
$siblings = @()
if ($parentKept) {
    $siblings = @(Get-ChildItem -LiteralPath $expectedParent -Force -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty Name)
}

[pscustomobject]@{
    status            = if ($leafGone) { 'removed' } else { 'incomplete' }
    leaf              = $leaf
    removedEntries    = $inventory.Count
    leafAbsent        = $leafGone
    parentPreserved   = $parentKept
    remainingSiblings = $siblings
} | ConvertTo-Json -Depth 6

if (-not $leafGone) { exit 1 }

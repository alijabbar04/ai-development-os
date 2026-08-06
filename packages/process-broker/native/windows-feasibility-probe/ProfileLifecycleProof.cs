using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32;

namespace AiDevOs.WindowsSandboxFeasibilityProbe;

internal static partial class AppContainerProfileLifecycleProof
{
    private const int ProtocolVersion = 5;
    private const string ProfilePrefix = "AiDevOs.Stage17.ProfileProof.";
    private const string AclRootPrefix = "ai-dev-os-stage17-profile-proof-";
    private const string AppContainerRegistryRoot =
        @"Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppContainer";
    private const int CleanupObservationAttempts = 50;
    private const int CleanupObservationDelayMs = 100;

    private static readonly FileSystemRights ProofRights =
        FileSystemRights.ReadAndExecute |
        FileSystemRights.Write |
        FileSystemRights.Delete |
        FileSystemRights.DeleteSubdirectoriesAndFiles;

    public static ProfileLifecycleProofResult Run(string profileName, string aclRoot)
    {
        string token = ValidateProfileName(profileName);
        string canonicalAclRoot = ValidateAclRoot(aclRoot, token);
        string profileNameFingerprint = Fingerprint(profileName);
        string aclRootFingerprint = Fingerprint(canonicalAclRoot);

        bool profileCreated = false;
        bool sidFreed = true;
        nint profileSidPointer = 0;
        string? profileSid = null;
        string? profileFolder = null;
        string? originalAcl = null;
        bool profileFolderObserved = false;
        bool mappingRegistryObserved = false;
        bool storageRegistryObserved = false;
        bool aclGrantObserved = false;
        bool aclRestored = false;
        bool aclDirectoryRemoved = false;
        int deleteAttempts = 0;
        bool profileDeleteSucceeded = false;
        string reason = "profile-lifecycle-proof-failed";

        try
        {
            profileSid = DeriveSidString(profileName);

            if (
                Directory.Exists(canonicalAclRoot) ||
                RegistryKeyExists(MappingRegistryPath(profileSid)) ||
                RegistryKeyExists(StorageRegistryPath(profileName)))
            {
                reason = "preexisting-profile-or-acl-state";
            }
            else
            {
                DirectoryInfo aclDirectory = Directory.CreateDirectory(canonicalAclRoot);
                DirectorySecurity initialSecurity = aclDirectory.GetAccessControl(
                    AccessControlSections.Access);
                originalAcl = initialSecurity.GetSecurityDescriptorSddlForm(
                    AccessControlSections.Access);

                int createResult = CreateAppContainerProfile(
                    profileName,
                    "AI Development OS Stage 17 lifecycle proof",
                    "Single authorized test-only profile lifecycle proof",
                    0,
                    0,
                    out profileSidPointer);

                if (createResult != 0 || profileSidPointer == 0)
                {
                    reason = "profile-create-failed";
                }
                else
                {
                    profileCreated = true;
                    string returnedSid = new SecurityIdentifier(profileSidPointer).Value;
                    if (!string.Equals(returnedSid, profileSid, StringComparison.Ordinal))
                    {
                        reason = "profile-sid-mismatch";
                    }
                    else
                    {
                        profileFolder = GetProfileFolder(profileSid);
                        profileFolderObserved = Directory.Exists(profileFolder);
                        mappingRegistryObserved = RegistryKeyExists(
                            MappingRegistryPath(profileSid));
                        storageRegistryObserved = RegistryKeyExists(
                            StorageRegistryPath(profileName));

                        var appContainerSid = new SecurityIdentifier(profileSid);
                        var accessRule = new FileSystemAccessRule(
                            appContainerSid,
                            ProofRights,
                            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
                            PropagationFlags.None,
                            AccessControlType.Allow);
                        DirectorySecurity grantedSecurity = aclDirectory.GetAccessControl(
                            AccessControlSections.Access);
                        grantedSecurity.AddAccessRule(accessRule);
                        aclDirectory.SetAccessControl(grantedSecurity);
                        aclGrantObserved = HasExplicitAllowRule(aclDirectory, appContainerSid);

                        aclRestored = RestoreAcl(
                            aclDirectory,
                            originalAcl,
                            appContainerSid);

                        if (
                            profileFolderObserved &&
                            mappingRegistryObserved &&
                            storageRegistryObserved &&
                            aclGrantObserved &&
                            aclRestored)
                        {
                            reason = "profile-lifecycle-observations-complete";
                        }
                        else
                        {
                            reason = "profile-lifecycle-observation-incomplete";
                        }
                    }
                }
            }
        }
        catch (Exception exception) when (!IsFatal(exception))
        {
            reason = "profile-lifecycle-proof-exception";
        }
        finally
        {
            if (profileSidPointer != 0)
            {
                sidFreed = FreeSid(profileSidPointer) == 0;
                profileSidPointer = 0;
            }

            if (Directory.Exists(canonicalAclRoot))
            {
                try
                {
                    var aclDirectory = new DirectoryInfo(canonicalAclRoot);
                    if (originalAcl is not null && profileSid is not null && !aclRestored)
                    {
                        aclRestored = RestoreAcl(
                            aclDirectory,
                            originalAcl,
                            new SecurityIdentifier(profileSid));
                    }

                    if (aclRestored || originalAcl is null)
                    {
                        Directory.Delete(canonicalAclRoot, recursive: false);
                    }
                }
                catch (Exception exception) when (!IsFatal(exception))
                {
                    aclRestored = false;
                }
            }

            aclDirectoryRemoved = !Directory.Exists(canonicalAclRoot);

            if (profileCreated)
            {
                deleteAttempts++;
                profileDeleteSucceeded = DeleteAppContainerProfile(profileName) == 0;
                if (!profileDeleteSucceeded)
                {
                    Thread.Sleep(CleanupObservationDelayMs);
                    deleteAttempts++;
                    profileDeleteSucceeded = DeleteAppContainerProfile(profileName) == 0;
                }
            }
        }

        bool profileFolderResidueAbsent = profileFolder is null || !Directory.Exists(profileFolder);
        bool mappingRegistryResidueAbsent =
            profileSid is null || !RegistryKeyExists(MappingRegistryPath(profileSid));
        bool storageRegistryResidueAbsent =
            !RegistryKeyExists(StorageRegistryPath(profileName));

        if (
            profileCreated &&
            profileDeleteSucceeded &&
            (!profileFolderResidueAbsent ||
             !mappingRegistryResidueAbsent ||
             !storageRegistryResidueAbsent))
        {
            for (int attempt = 0; attempt < CleanupObservationAttempts; attempt++)
            {
                Thread.Sleep(CleanupObservationDelayMs);
                profileFolderResidueAbsent =
                    profileFolder is null || !Directory.Exists(profileFolder);
                mappingRegistryResidueAbsent =
                    profileSid is null || !RegistryKeyExists(MappingRegistryPath(profileSid));
                storageRegistryResidueAbsent =
                    !RegistryKeyExists(StorageRegistryPath(profileName));
                if (
                    profileFolderResidueAbsent &&
                    mappingRegistryResidueAbsent &&
                    storageRegistryResidueAbsent)
                {
                    break;
                }
            }
        }

        bool cleanupConfirmed =
            sidFreed &&
            aclRestored &&
            aclDirectoryRemoved &&
            profileCreated &&
            profileDeleteSucceeded &&
            profileFolderResidueAbsent &&
            mappingRegistryResidueAbsent &&
            storageRegistryResidueAbsent;

        bool passed =
            cleanupConfirmed &&
            profileFolderObserved &&
            mappingRegistryObserved &&
            storageRegistryObserved &&
            aclGrantObserved;

        if (passed)
        {
            reason = "profile-lifecycle-proof-passed";
        }
        else if (profileCreated && !cleanupConfirmed)
        {
            reason = "profile-lifecycle-cleanup-unconfirmed";
        }

        return new ProfileLifecycleProofResult(
            SchemaVersion: 1,
            ProtocolVersion: ProtocolVersion,
            Status: passed ? "passed" : "failed",
            Reason: reason,
            ProfileNameFingerprint: profileNameFingerprint,
            ProfileSidFingerprint: profileSid is null ? null : Fingerprint(profileSid),
            AclRootFingerprint: aclRootFingerprint,
            ProfileCreated: profileCreated,
            CapabilitiesRequested: false,
            ProcessCreationAttempted: false,
            ProfileFolderObserved: profileFolderObserved,
            MappingRegistryObserved: mappingRegistryObserved,
            StorageRegistryObserved: storageRegistryObserved,
            AclGrantObserved: aclGrantObserved,
            AclRestored: aclRestored,
            AclDirectoryRemoved: aclDirectoryRemoved,
            SidFreed: sidFreed,
            DeleteAttempts: deleteAttempts,
            ProfileDeleteSucceeded: profileDeleteSucceeded,
            ProfileFolderResidueAbsent: profileFolderResidueAbsent,
            MappingRegistryResidueAbsent: mappingRegistryResidueAbsent,
            StorageRegistryResidueAbsent: storageRegistryResidueAbsent,
            CleanupConfirmed: cleanupConfirmed);
    }

    private static string ValidateProfileName(string profileName)
    {
        Match match = ProfileNamePattern().Match(profileName);
        if (!match.Success || profileName.Length > 64)
        {
            throw new ArgumentException("invalid-profile-proof-name", nameof(profileName));
        }

        return match.Groups[1].Value;
    }

    private static string ValidateAclRoot(string aclRoot, string token)
    {
        string canonical = Path.GetFullPath(aclRoot);
        string tempRoot = Path.TrimEndingDirectorySeparator(Path.GetFullPath(Path.GetTempPath()));
        string? parent = Path.GetDirectoryName(canonical);
        string expectedName = $"{AclRootPrefix}{token}";
        if (
            !string.Equals(parent, tempRoot, StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(Path.GetFileName(canonical), expectedName, StringComparison.Ordinal))
        {
            throw new ArgumentException("invalid-profile-proof-acl-root", nameof(aclRoot));
        }

        return canonical;
    }

    private static string DeriveSidString(string profileName)
    {
        int result = DeriveAppContainerSidFromAppContainerName(profileName, out nint sidPointer);
        if (result != 0 || sidPointer == 0)
        {
            throw new InvalidOperationException("profile-sid-derivation-failed");
        }

        string sid;
        nint freeResult;
        try
        {
            sid = new SecurityIdentifier(sidPointer).Value;
        }
        finally
        {
            freeResult = FreeSid(sidPointer);
        }

        return freeResult == 0
            ? sid
            : throw new InvalidOperationException("profile-sid-free-failed");
    }

    private static string GetProfileFolder(string profileSid)
    {
        int result = GetAppContainerFolderPath(profileSid, out nint pathPointer);
        if (result != 0 || pathPointer == 0)
        {
            throw new InvalidOperationException("profile-folder-resolution-failed");
        }

        try
        {
            return Path.GetFullPath(
                Marshal.PtrToStringUni(pathPointer) ??
                throw new InvalidOperationException("profile-folder-resolution-failed"));
        }
        finally
        {
            Marshal.FreeCoTaskMem(pathPointer);
        }
    }

    private static bool HasExplicitAllowRule(
        DirectoryInfo directory,
        SecurityIdentifier expectedSid)
    {
        DirectorySecurity security = directory.GetAccessControl(AccessControlSections.Access);
        AuthorizationRuleCollection rules = security.GetAccessRules(
            includeExplicit: true,
            includeInherited: false,
            targetType: typeof(SecurityIdentifier));
        foreach (AuthorizationRule rule in rules)
        {
            if (
                rule is FileSystemAccessRule fileRule &&
                fileRule.AccessControlType == AccessControlType.Allow &&
                fileRule.IdentityReference == expectedSid &&
                (fileRule.FileSystemRights & ProofRights) == ProofRights)
            {
                return true;
            }
        }

        return false;
    }

    private static bool RestoreAcl(
        DirectoryInfo directory,
        string originalAcl,
        SecurityIdentifier appContainerSid)
    {
        var restored = new DirectorySecurity();
        restored.SetSecurityDescriptorSddlForm(originalAcl, AccessControlSections.Access);
        directory.SetAccessControl(restored);

        DirectorySecurity observed = directory.GetAccessControl(AccessControlSections.Access);
        string observedAcl = observed.GetSecurityDescriptorSddlForm(AccessControlSections.Access);
        return
            string.Equals(observedAcl, originalAcl, StringComparison.Ordinal) &&
            !HasAnyRule(directory, appContainerSid);
    }

    private static bool HasAnyRule(
        DirectoryInfo directory,
        SecurityIdentifier expectedSid)
    {
        DirectorySecurity security = directory.GetAccessControl(AccessControlSections.Access);
        AuthorizationRuleCollection rules = security.GetAccessRules(
            includeExplicit: true,
            includeInherited: true,
            targetType: typeof(SecurityIdentifier));
        foreach (AuthorizationRule rule in rules)
        {
            if (rule.IdentityReference == expectedSid)
            {
                return true;
            }
        }

        return false;
    }

    private static bool RegistryKeyExists(string path)
    {
        using RegistryKey currentUser = RegistryKey.OpenBaseKey(
            RegistryHive.CurrentUser,
            RegistryView.Default);
        using RegistryKey? key = currentUser.OpenSubKey(path, writable: false);
        return key is not null;
    }

    private static string MappingRegistryPath(string profileSid) =>
        $@"{AppContainerRegistryRoot}\Mappings\{profileSid}";

    private static string StorageRegistryPath(string profileName) =>
        $@"{AppContainerRegistryRoot}\Storage\{profileName}";

    private static string Fingerprint(string value) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

    private static bool IsFatal(Exception exception) =>
        exception is OutOfMemoryException or StackOverflowException or AccessViolationException;

    [GeneratedRegex(
        "^AiDevOs\\.Stage17\\.ProfileProof\\.([a-f0-9]{32})$",
        RegexOptions.CultureInvariant)]
    private static partial Regex ProfileNamePattern();

    [DllImport(
        "userenv.dll",
        EntryPoint = "CreateAppContainerProfile",
        ExactSpelling = true,
        CharSet = CharSet.Unicode)]
    private static extern int CreateAppContainerProfile(
        string appContainerName,
        string displayName,
        string description,
        nint capabilities,
        uint capabilityCount,
        out nint appContainerSid);

    [DllImport(
        "userenv.dll",
        EntryPoint = "DeleteAppContainerProfile",
        ExactSpelling = true,
        CharSet = CharSet.Unicode)]
    private static extern int DeleteAppContainerProfile(string appContainerName);

    [DllImport(
        "userenv.dll",
        EntryPoint = "DeriveAppContainerSidFromAppContainerName",
        ExactSpelling = true,
        CharSet = CharSet.Unicode)]
    private static extern int DeriveAppContainerSidFromAppContainerName(
        string appContainerName,
        out nint appContainerSid);

    [DllImport(
        "userenv.dll",
        EntryPoint = "GetAppContainerFolderPath",
        ExactSpelling = true,
        CharSet = CharSet.Unicode)]
    private static extern int GetAppContainerFolderPath(
        string appContainerSid,
        out nint path);

    [DllImport("advapi32.dll", EntryPoint = "FreeSid", ExactSpelling = true)]
    private static extern nint FreeSid(nint sid);
}

internal sealed record ProfileLifecycleProofResult(
    int SchemaVersion,
    int ProtocolVersion,
    string Status,
    string Reason,
    string ProfileNameFingerprint,
    string? ProfileSidFingerprint,
    string AclRootFingerprint,
    bool ProfileCreated,
    bool CapabilitiesRequested,
    bool ProcessCreationAttempted,
    bool ProfileFolderObserved,
    bool MappingRegistryObserved,
    bool StorageRegistryObserved,
    bool AclGrantObserved,
    bool AclRestored,
    bool AclDirectoryRemoved,
    bool SidFreed,
    int DeleteAttempts,
    bool ProfileDeleteSucceeded,
    bool ProfileFolderResidueAbsent,
    bool MappingRegistryResidueAbsent,
    bool StorageRegistryResidueAbsent,
    bool CleanupConfirmed);

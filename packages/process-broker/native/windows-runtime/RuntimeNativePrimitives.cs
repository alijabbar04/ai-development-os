using System;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32;

[assembly: DefaultDllImportSearchPaths(DllImportSearchPath.System32)]

namespace AiDevOs.WindowsRuntime;

internal static partial class WindowsRuntimeBoundary
{
    private const int ProtocolVersion = 5;
    private const string ProfilePrefix = "AiDevOs.Stage17.ProcessProof.";
    private const string StagingRootPrefix = "ai-dev-os-stage17-process-proof-";
    private const string FixtureMarker = "stage17-synthetic-fixture";
    private const string AppContainerRegistryRoot =
        @"Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppContainer";
    private const int CleanupObservationAttempts = 50;
    private const int CleanupObservationDelayMs = 100;
    private const uint TokenQuery = 0x0008;
    private const int TokenIsAppContainer = 29;
    private const int TokenCapabilities = 30;
    private const int TokenAppContainerSid = 31;
    private const uint StartfUseStdHandles = 0x00000100;
    private const uint CreateSuspended = 0x00000004;
    private const uint CreateUnicodeEnvironment = 0x00000400;
    private const uint ExtendedStartupInfoPresent = 0x00080000;
    private const nuint ProcThreadAttributeHandleList = 0x00020002;
    private const nuint ProcThreadAttributeSecurityCapabilities = 0x00020009;
    private const nuint ProcThreadAttributeJobList = 0x0002000D;
    private const uint JobObjectLimitActiveProcess = 0x00000008;
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private const int JobObjectBasicAccountingInformationClass = 1;
    private const int JobObjectExtendedLimitInformationClass = 9;
    private const uint HandleFlagInherit = 0x00000001;
    private const uint GenericRead = 0x80000000;
    private const uint FileShareRead = 0x00000001;
    private const uint FileShareWrite = 0x00000002;
    private const uint OpenExisting = 3;
    private const uint WaitObject0 = 0;
    private const uint WaitTimeout = 258;
    private const uint StillActive = 259;
    private const uint ProcessWaitMilliseconds = 10_000;
    private const uint JobDrainWaitMilliseconds = 5_000;
    private const int MaximumFixtureOutputBytes = 4_096;

    private static readonly FileSystemRights StagingRights =
        FileSystemRights.ReadAndExecute;


    private static string ValidateProfileName(string profileName)
    {
        Match match = ProfileNamePattern().Match(profileName);
        if (!match.Success || profileName.Length > 64)
        {
            throw new ArgumentException("invalid-process-proof-name", nameof(profileName));
        }

        return match.Groups[1].Value;
    }

    private static string ValidateStagingRoot(string stagingRoot, string token)
    {
        string canonical = Path.GetFullPath(stagingRoot);
        string tempRoot = Path.TrimEndingDirectorySeparator(Path.GetFullPath(Path.GetTempPath()));
        string? parent = Path.GetDirectoryName(canonical);
        string expectedName = $"{StagingRootPrefix}{token}";
        if (
            !string.Equals(parent, tempRoot, StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(Path.GetFileName(canonical), expectedName, StringComparison.Ordinal))
        {
            throw new ArgumentException("invalid-process-proof-staging-root", nameof(stagingRoot));
        }

        return canonical;
    }

    private static string ExactSystemImagePath(string fileName)
    {
        string systemDirectory = Path.GetFullPath(
            Environment.GetFolderPath(Environment.SpecialFolder.System));
        string candidate = Path.GetFullPath(Path.Combine(systemDirectory, fileName));
        if (!string.Equals(
            Path.GetDirectoryName(candidate),
            systemDirectory,
            StringComparison.OrdinalIgnoreCase))
        {
            throw new ProofException("system-image-resolution-failed");
        }

        return candidate;
    }

    private static string DeriveSidString(string profileName)
    {
        int result = DeriveAppContainerSidFromAppContainerName(profileName, out nint sidPointer);
        if (result != 0 || sidPointer == 0)
        {
            throw new ProofException("profile-sid-derivation-failed", result);
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
            : throw new ProofException("profile-sid-free-failed");
    }

    private static string GetProfileFolder(string profileSid)
    {
        int result = GetAppContainerFolderPath(profileSid, out nint pathPointer);
        if (result != 0 || pathPointer == 0)
        {
            throw new ProofException("profile-folder-resolution-failed", result);
        }

        try
        {
            return Path.GetFullPath(
                Marshal.PtrToStringUni(pathPointer) ??
                throw new ProofException("profile-folder-resolution-failed"));
        }
        finally
        {
            Marshal.FreeCoTaskMem(pathPointer);
        }
    }

    private static void GrantStagingAccess(
        DirectoryInfo directory,
        SecurityIdentifier appContainerSid)
    {
        DirectorySecurity security = directory.GetAccessControl(AccessControlSections.Access);
        security.AddAccessRule(
            new FileSystemAccessRule(
                appContainerSid,
                StagingRights,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
                PropagationFlags.None,
                AccessControlType.Allow));
        directory.SetAccessControl(security);
    }

    private static bool HasAllowRule(
        FileSystemSecurity security,
        SecurityIdentifier expectedSid,
        bool requireExplicit)
    {
        AuthorizationRuleCollection rules = security.GetAccessRules(
            includeExplicit: true,
            includeInherited: true,
            targetType: typeof(SecurityIdentifier));
        foreach (AuthorizationRule rule in rules)
        {
            if (
                rule is FileSystemAccessRule fileRule &&
                fileRule.AccessControlType == AccessControlType.Allow &&
                fileRule.IdentityReference == expectedSid &&
                (!requireExplicit || !fileRule.IsInherited) &&
                (fileRule.FileSystemRights & StagingRights) == StagingRights)
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
            !HasAnyRule(observed, appContainerSid);
    }

    private static bool HasAnyRule(
        FileSystemSecurity security,
        SecurityIdentifier expectedSid)
    {
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

    private static void CreateRestrictedStandardHandles(
        out nint standardInput,
        out nint standardOutputRead,
        out nint standardOutputWrite)
    {
        standardInput = 0;
        standardOutputRead = 0;
        standardOutputWrite = 0;
        var inheritable = new SecurityAttributes
        {
            Length = checked((uint)Marshal.SizeOf<SecurityAttributes>()),
            InheritHandle = true,
        };

        standardInput = CreateFileW(
            "NUL",
            GenericRead,
            FileShareRead | FileShareWrite,
            ref inheritable,
            OpenExisting,
            0,
            0);
        EnsureHandle(standardInput, "standard-input-create-failed");

        EnsureWin32(
            CreatePipe(
                out standardOutputRead,
                out standardOutputWrite,
                ref inheritable,
                MaximumFixtureOutputBytes),
            "standard-output-pipe-create-failed");
        EnsureWin32(
            SetHandleInformation(standardOutputRead, HandleFlagInherit, 0),
            "standard-output-read-inheritance-clear-failed");
    }

    private static void InitializeAttributeList(
        nint profileSid,
        nint jobHandle,
        nint standardInput,
        nint standardOutput,
        out nint attributeList,
        out bool attributeListInitialized,
        out nint securityCapabilitiesPointer,
        out nint jobListPointer,
        out nint handleListPointer)
    {
        attributeList = 0;
        attributeListInitialized = false;
        securityCapabilitiesPointer = 0;
        jobListPointer = 0;
        handleListPointer = 0;

        nuint attributeListSize = 0;
        _ = InitializeProcThreadAttributeList(0, 3, 0, ref attributeListSize);
        if (attributeListSize == 0)
        {
            throw new ProofException(
                "attribute-list-size-query-failed",
                Marshal.GetLastWin32Error());
        }

        attributeList = Marshal.AllocHGlobal(checked((int)attributeListSize));
        EnsureWin32(
            InitializeProcThreadAttributeList(
                attributeList,
                3,
                0,
                ref attributeListSize),
            "attribute-list-initialize-failed");
        attributeListInitialized = true;

        var capabilities = new SecurityCapabilities
        {
            AppContainerSid = profileSid,
            Capabilities = 0,
            CapabilityCount = 0,
            Reserved = 0,
        };
        securityCapabilitiesPointer = Marshal.AllocHGlobal(
            Marshal.SizeOf<SecurityCapabilities>());
        Marshal.StructureToPtr(capabilities, securityCapabilitiesPointer, fDeleteOld: false);

        jobListPointer = Marshal.AllocHGlobal(nint.Size);
        Marshal.WriteIntPtr(jobListPointer, jobHandle);

        handleListPointer = Marshal.AllocHGlobal(checked(2 * nint.Size));
        Marshal.WriteIntPtr(handleListPointer, 0, standardInput);
        Marshal.WriteIntPtr(handleListPointer, nint.Size, standardOutput);

        EnsureWin32(
            UpdateProcThreadAttribute(
                attributeList,
                0,
                ProcThreadAttributeSecurityCapabilities,
                securityCapabilitiesPointer,
                checked((nuint)Marshal.SizeOf<SecurityCapabilities>()),
                0,
                0),
            "security-capabilities-attribute-update-failed");
        EnsureWin32(
            UpdateProcThreadAttribute(
                attributeList,
                0,
                ProcThreadAttributeJobList,
                jobListPointer,
                checked((nuint)nint.Size),
                0,
                0),
            "job-list-attribute-update-failed");
        EnsureWin32(
            UpdateProcThreadAttribute(
                attributeList,
                0,
                ProcThreadAttributeHandleList,
                handleListPointer,
                checked((nuint)(2 * nint.Size)),
                0,
                0),
            "handle-list-attribute-update-failed");
    }

    private static nint CreateMinimalEnvironment(
        string stagedImage,
        string profileFolder,
        string stagingRoot)
    {
        string systemRoot = Path.GetFullPath(
            Environment.GetFolderPath(Environment.SpecialFolder.Windows));
        string systemDrive = Path.TrimEndingDirectorySeparator(
            Path.GetPathRoot(systemRoot) ??
            throw new ProofException("system-drive-resolution-failed"));
        string stagingDrive = Path.TrimEndingDirectorySeparator(
            Path.GetPathRoot(stagingRoot) ??
            throw new ProofException("staging-drive-resolution-failed"));
        string profileTemp = Path.Combine(profileFolder, "Temp");
        string block = string.Join(
            '\0',
            $"={stagingDrive}={stagingRoot}",
            $"COMSPEC={stagedImage}",
            $"LOCALAPPDATA={profileFolder}",
            $"SystemDrive={systemDrive}",
            $"SystemRoot={systemRoot}",
            $"TEMP={profileTemp}",
            $"TMP={profileTemp}",
            $"WINDIR={systemRoot}") + '\0';
        return Marshal.StringToHGlobalUni(block);
    }

    private static uint ReadTokenUInt32(
        nint tokenHandle,
        int informationClass,
        string errorCode)
    {
        nint buffer = Marshal.AllocHGlobal(sizeof(uint));
        try
        {
            EnsureWin32(
                GetTokenInformation(
                    tokenHandle,
                    informationClass,
                    buffer,
                    sizeof(uint),
                    out _),
                errorCode);
            return unchecked((uint)Marshal.ReadInt32(buffer));
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static string ReadTokenAppContainerSid(nint tokenHandle)
    {
        nint buffer = AllocateTokenInformation(
            tokenHandle,
            TokenAppContainerSid,
            "token-appcontainer-sid-query-failed");
        try
        {
            nint sidPointer = Marshal.ReadIntPtr(buffer);
            if (sidPointer == 0)
            {
                throw new ProofException("token-appcontainer-sid-missing");
            }

            return new SecurityIdentifier(sidPointer).Value;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static uint ReadTokenGroupCount(
        nint tokenHandle,
        int informationClass,
        string errorCode)
    {
        nint buffer = AllocateTokenInformation(tokenHandle, informationClass, errorCode);
        try
        {
            return unchecked((uint)Marshal.ReadInt32(buffer));
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static nint AllocateTokenInformation(
        nint tokenHandle,
        int informationClass,
        string errorCode)
    {
        _ = GetTokenInformation(tokenHandle, informationClass, 0, 0, out uint size);
        if (size == 0)
        {
            throw new ProofException(errorCode, Marshal.GetLastWin32Error());
        }

        nint buffer = Marshal.AllocHGlobal(checked((int)size));
        try
        {
            EnsureWin32(
                GetTokenInformation(tokenHandle, informationClass, buffer, size, out _),
                errorCode);
            return buffer;
        }
        catch
        {
            Marshal.FreeHGlobal(buffer);
            throw;
        }
    }

    private static JobObjectBasicAccountingInformation QueryJobAccounting(nint jobHandle)
    {
        EnsureWin32(
            QueryInformationJobObject(
                jobHandle,
                JobObjectBasicAccountingInformationClass,
                out JobObjectBasicAccountingInformation accounting,
                checked((uint)Marshal.SizeOf<JobObjectBasicAccountingInformation>()),
                out _),
            "job-accounting-query-failed");
        return accounting;
    }

    private static bool ReadFixtureOutput(nint readHandle)
    {
        byte[] output = new byte[MaximumFixtureOutputBytes];
        EnsureWin32(
            ReadFile(
                readHandle,
                output,
                checked((uint)output.Length),
                out uint bytesRead,
                0),
            "fixture-output-read-failed");
        string text = Encoding.UTF8.GetString(output, 0, checked((int)bytesRead));
        return string.Equals(text.Trim(), FixtureMarker, StringComparison.Ordinal);
    }

    private static string HashFile(string path)
    {
        using FileStream stream = new(
            path,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            bufferSize: 128 * 1024,
            FileOptions.SequentialScan);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
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

    private static void EnsureHandle(nint handle, string errorCode)
    {
        if (handle == 0 || handle == new nint(-1))
        {
            throw new ProofException(errorCode, Marshal.GetLastWin32Error());
        }
    }

    private static void EnsureWin32(bool succeeded, string errorCode)
    {
        if (!succeeded)
        {
            throw new ProofException(errorCode, Marshal.GetLastWin32Error());
        }
    }

    private static void CloseNativeHandle(ref nint handle)
    {
        if (handle != 0 && handle != new nint(-1))
        {
            _ = CloseHandle(handle);
        }

        handle = 0;
    }

    private static void FreeUnmanaged(ref nint pointer)
    {
        if (pointer != 0)
        {
            Marshal.FreeHGlobal(pointer);
            pointer = 0;
        }
    }

    private static bool IsFatal(Exception exception) =>
        exception is OutOfMemoryException or StackOverflowException or AccessViolationException;

    private sealed class ProofException : Exception
    {
        internal ProofException(string code, int? nativeErrorCode = null)
            : base(code)
        {
            Code = code;
            NativeErrorCode = nativeErrorCode;
        }

        internal string Code { get; }

        internal int? NativeErrorCode { get; }
    }

    [GeneratedRegex(
        "^AiDevOs\\.Stage17\\.ProcessProof\\.([a-f0-9]{32})$",
        RegexOptions.CultureInvariant)]
    private static partial Regex ProfileNamePattern();

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes
    {
        internal uint Length;
        internal nint SecurityDescriptor;
        [MarshalAs(UnmanagedType.Bool)]
        internal bool InheritHandle;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityCapabilities
    {
        internal nint AppContainerSid;
        internal nint Capabilities;
        internal uint CapabilityCount;
        internal uint Reserved;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfo
    {
        internal uint Cb;
        internal nint Reserved;
        internal nint Desktop;
        internal nint Title;
        internal uint X;
        internal uint Y;
        internal uint XSize;
        internal uint YSize;
        internal uint XCountChars;
        internal uint YCountChars;
        internal uint FillAttribute;
        internal uint Flags;
        internal ushort ShowWindow;
        internal ushort Reserved2Count;
        internal nint Reserved2;
        internal nint StandardInput;
        internal nint StandardOutput;
        internal nint StandardError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfoEx
    {
        internal StartupInfo StartupInfo;
        internal nint AttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        internal nint Process;
        internal nint Thread;
        internal uint ProcessId;
        internal uint ThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicLimitInformation
    {
        internal long PerProcessUserTimeLimit;
        internal long PerJobUserTimeLimit;
        internal uint LimitFlags;
        internal nuint MinimumWorkingSetSize;
        internal nuint MaximumWorkingSetSize;
        internal uint ActiveProcessLimit;
        internal nuint Affinity;
        internal uint PriorityClass;
        internal uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        internal ulong ReadOperationCount;
        internal ulong WriteOperationCount;
        internal ulong OtherOperationCount;
        internal ulong ReadTransferCount;
        internal ulong WriteTransferCount;
        internal ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectExtendedLimitInformation
    {
        internal JobObjectBasicLimitInformation BasicLimitInformation;
        internal IoCounters IoInfo;
        internal nuint ProcessMemoryLimit;
        internal nuint JobMemoryLimit;
        internal nuint PeakProcessMemoryUsed;
        internal nuint PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicAccountingInformation
    {
        internal long TotalUserTime;
        internal long TotalKernelTime;
        internal long ThisPeriodTotalUserTime;
        internal long ThisPeriodTotalKernelTime;
        internal uint TotalPageFaultCount;
        internal uint TotalProcesses;
        internal uint ActiveProcesses;
        internal uint TotalTerminatedProcesses;
    }

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
    private static extern int GetAppContainerFolderPath(string appContainerSid, out nint path);

    [DllImport("advapi32.dll", EntryPoint = "FreeSid", ExactSpelling = true)]
    private static extern nint FreeSid(nint sid);

    [DllImport(
        "advapi32.dll",
        EntryPoint = "OpenProcessToken",
        ExactSpelling = true,
        SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenProcessToken(
        nint processHandle,
        uint desiredAccess,
        out nint tokenHandle);

    [DllImport(
        "advapi32.dll",
        EntryPoint = "GetTokenInformation",
        ExactSpelling = true,
        SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetTokenInformation(
        nint tokenHandle,
        int tokenInformationClass,
        nint tokenInformation,
        uint tokenInformationLength,
        out uint returnLength);

    [DllImport(
        "kernel32.dll",
        EntryPoint = "CreateJobObjectW",
        ExactSpelling = true,
        CharSet = CharSet.Unicode,
        SetLastError = true)]
    private static extern nint CreateJobObjectW(nint jobAttributes, string? name);

    [DllImport(
        "kernel32.dll",
        EntryPoint = "SetInformationJobObject",
        ExactSpelling = true,
        SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(
        nint jobHandle,
        int informationClass,
        ref JobObjectExtendedLimitInformation information,
        uint informationLength);

    [DllImport(
        "kernel32.dll",
        EntryPoint = "QueryInformationJobObject",
        ExactSpelling = true,
        SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryInformationJobObject(
        nint jobHandle,
        int informationClass,
        out JobObjectBasicAccountingInformation information,
        uint informationLength,
        out uint returnLength);

    [DllImport(
        "kernel32.dll",
        EntryPoint = "CreatePipe",
        ExactSpelling = true,
        SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreatePipe(
        out nint readPipe,
        out nint writePipe,
        ref SecurityAttributes pipeAttributes,
        int size);

    [DllImport(
        "kernel32.dll",
        EntryPoint = "CreateFileW",
        ExactSpelling = true,
        CharSet = CharSet.Unicode,
        SetLastError = true)]
    private static extern nint CreateFileW(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        ref SecurityAttributes securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        nint templateFile);

    [DllImport(
        "kernel32.dll",
        EntryPoint = "SetHandleInformation",
        ExactSpelling = true,
        SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetHandleInformation(
        nint objectHandle,
        uint mask,
        uint flags);

    [DllImport(
        "kernel32.dll",
        EntryPoint = "InitializeProcThreadAttributeList",
        ExactSpelling = true,
        SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool InitializeProcThreadAttributeList(
        nint attributeList,
        uint attributeCount,
        uint flags,
        ref nuint size);

    [DllImport(
        "kernel32.dll",
        EntryPoint = "UpdateProcThreadAttribute",
        ExactSpelling = true,
        SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UpdateProcThreadAttribute(
        nint attributeList,
        uint flags,
        nuint attribute,
        nint value,
        nuint size,
        nint previousValue,
        nint returnSize);

    [DllImport(
        "kernel32.dll",
        EntryPoint = "DeleteProcThreadAttributeList",
        ExactSpelling = true)]
    private static extern void DeleteProcThreadAttributeList(nint attributeList);

    [DllImport(
        "kernel32.dll",
        EntryPoint = "CreateProcessW",
        ExactSpelling = true,
        CharSet = CharSet.Unicode,
        SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcessW(
        string applicationName,
        [In, Out] char[] commandLine,
        nint processAttributes,
        nint threadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
        uint creationFlags,
        nint environment,
        string currentDirectory,
        ref StartupInfoEx startupInfo,
        out ProcessInformation processInformation);

    [DllImport(
        "kernel32.dll",
        EntryPoint = "IsProcessInJob",
        ExactSpelling = true,
        SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsProcessInJob(
        nint processHandle,
        nint jobHandle,
        [MarshalAs(UnmanagedType.Bool)] out bool result);

    [DllImport(
        "kernel32.dll",
        EntryPoint = "ResumeThread",
        ExactSpelling = true,
        SetLastError = true)]
    private static extern uint ResumeThread(nint threadHandle);

    [DllImport(
        "kernel32.dll",
        EntryPoint = "WaitForSingleObject",
        ExactSpelling = true,
        SetLastError = true)]
    private static extern uint WaitForSingleObject(nint handle, uint milliseconds);

    [DllImport(
        "kernel32.dll",
        EntryPoint = "GetExitCodeProcess",
        ExactSpelling = true,
        SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetExitCodeProcess(nint processHandle, out uint exitCode);

    [DllImport(
        "kernel32.dll",
        EntryPoint = "TerminateJobObject",
        ExactSpelling = true,
        SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateJobObject(nint jobHandle, uint exitCode);

    [DllImport(
        "kernel32.dll",
        EntryPoint = "ReadFile",
        ExactSpelling = true,
        SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ReadFile(
        nint fileHandle,
        byte[] buffer,
        uint bytesToRead,
        out uint bytesRead,
        nint overlapped);

    [DllImport("kernel32.dll", EntryPoint = "CloseHandle", ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(nint handle);
}

internal sealed record SyntheticProcessProofResult(
    int SchemaVersion,
    int ProtocolVersion,
    string Status,
    string Reason,
    int? NativeErrorCode,
    string ProfileNameFingerprint,
    string? ProfileSidFingerprint,
    string StagingRootFingerprint,
    string? SourceImageSha256,
    string? StagedImageSha256,
    bool ProfileCreated,
    bool CapabilitiesRequested,
    bool ProfileFolderObserved,
    bool MappingRegistryObserved,
    bool StorageRegistryObserved,
    bool StagingDirectoryCreated,
    bool StagingAclGrantObserved,
    bool StagingFileAclGrantObserved,
    bool SourceImageIsReparsePoint,
    bool StagedImageCopied,
    bool StagedBytesMatched,
    bool JobCreated,
    bool KillOnJobCloseConfigured,
    bool ActiveProcessLimitConfigured,
    bool BreakawayAllowed,
    int CreationAttributeCount,
    bool HandleListConfigured,
    int InheritedHandleCount,
    int MinimalEnvironmentEntryCount,
    bool ProcessCreationAttempted,
    bool ProcessCreated,
    bool CreatedSuspended,
    bool AppContainerTokenObserved,
    bool ProfileSidMatched,
    int? TokenCapabilityCount,
    bool ProcessInPrivateJobBeforeResume,
    uint? PrivateJobActiveProcessCountBeforeResume,
    bool ResumeAttempted,
    uint? ResumePreviousSuspendCount,
    bool BoundaryObservedBeforeResume,
    bool FixtureMarkerObserved,
    bool ProcessExitObserved,
    bool ProcessExitCodeZero,
    bool JobTerminationAttempted,
    bool JobTerminationSucceeded,
    bool JobDrained,
    bool ProcessCleanupConfirmed,
    bool StagingAclRestored,
    bool StagedImageRemoved,
    bool StagingDirectoryRemoved,
    bool SidFreed,
    int DeleteAttempts,
    bool ProfileDeleteSucceeded,
    bool ProfileFolderResidueAbsent,
    bool MappingRegistryResidueAbsent,
    bool StorageRegistryResidueAbsent,
    bool CleanupConfirmed,
    bool ProductionBackendAvailable);

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

// Controlled DLL-search posture for the WHOLE assembly, not just this file.
// Every P/Invoke in this component resolves only from %SystemRoot%\System32, so
// none of them can be satisfied by a DLL dropped next to the executable, in the
// current directory, or anywhere on PATH. Declared at assembly scope
// deliberately: a per-method attribute would have to be remembered on each new
// import, and the one that gets forgotten is the one that matters.
[assembly: System.Runtime.InteropServices.DefaultDllImportSearchPaths(
    System.Runtime.InteropServices.DllImportSearchPath.System32)]

namespace AiDevOs.WindowsProofInstaller;

/// <summary>
/// The ONLY file in this component that contains interop.
///
/// ADR 0018 section 5 names it explicitly, and section 2.2 states the honest
/// limit of what calling these functions buys: the guarantee depends on every
/// one of correct <c>RootDirectory</c> use on each hop, the reparse flags
/// actually being set, share modes that exclude delete, handle lifetime
/// spanning the whole transaction, correct <c>NTSTATUS</c>-to-refusal mapping,
/// correct native allocation and release, and no fallback path that quietly
/// reverts to a path-based API. Calling <c>NtCreateFile</c> does not by itself
/// close the boundary and this file does not claim it does.
///
/// Everything here is declared with an explicit <c>DllImport</c> rather than
/// <c>LibraryImport</c>. That is a deliberate choice against the compiler's
/// advice (SYSLIB1054 is suppressed project-wide for it): the source generator
/// emits the real <c>DllImport</c> into <c>obj/</c>, where no reviewer and no
/// allow-list test can see it, and an interop boundary whose declarations are
/// invisible to review is not a boundary.
/// </summary>
internal static class NativeMethods
{
    // ------------------------------------------------------------ structures

    [StructLayout(LayoutKind.Sequential)]
    internal struct UNICODE_STRING
    {
        internal ushort Length;
        internal ushort MaximumLength;
        internal nint Buffer;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct OBJECT_ATTRIBUTES
    {
        internal int Length;

        /// <summary>
        /// The field this entire component exists for. When it is a directory
        /// handle, <c>ObjectName</c> is resolved relative to that OBJECT rather
        /// than to a string, so nothing above it can be re-bound between one
        /// hop and the next.
        /// </summary>
        internal nint RootDirectory;

        internal nint ObjectName;
        internal uint Attributes;
        internal nint SecurityDescriptor;
        internal nint SecurityQualityOfService;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct IO_STATUS_BLOCK
    {
        internal nint Status;
        internal nuint Information;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct FILE_ATTRIBUTE_TAG_INFORMATION
    {
        internal uint FileAttributes;
        internal uint ReparseTag;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct FILE_DISPOSITION_INFORMATION_EX
    {
        internal uint Flags;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct GENERIC_MAPPING
    {
        internal uint GenericRead;
        internal uint GenericWrite;
        internal uint GenericExecute;
        internal uint GenericAll;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct ACL_SIZE_INFORMATION
    {
        internal uint AceCount;
        internal uint AclBytesInUse;
        internal uint AclBytesFree;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct ACE_HEADER
    {
        internal byte AceType;
        internal byte AceFlags;
        internal ushort AceSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct SID_AND_ATTRIBUTES
    {
        internal nint Sid;
        internal uint Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct TOKEN_ELEVATION
    {
        internal uint TokenIsElevated;
    }

    // ---------------------------------------------------------------- ntdll

    [DllImport("ntdll.dll", EntryPoint = "NtCreateFile", ExactSpelling = true)]
    internal static extern uint NtCreateFile(
        out nint fileHandle,
        uint desiredAccess,
        ref OBJECT_ATTRIBUTES objectAttributes,
        out IO_STATUS_BLOCK ioStatusBlock,
        nint allocationSize,
        uint fileAttributes,
        uint shareAccess,
        uint createDisposition,
        uint createOptions,
        nint eaBuffer,
        uint eaLength);

    [DllImport("ntdll.dll", EntryPoint = "NtQueryInformationFile", ExactSpelling = true)]
    internal static extern uint NtQueryInformationFile(
        nint fileHandle,
        out IO_STATUS_BLOCK ioStatusBlock,
        nint fileInformation,
        uint length,
        int fileInformationClass);

    [DllImport("ntdll.dll", EntryPoint = "NtSetInformationFile", ExactSpelling = true)]
    internal static extern uint NtSetInformationFile(
        nint fileHandle,
        out IO_STATUS_BLOCK ioStatusBlock,
        nint fileInformation,
        uint length,
        int fileInformationClass);

    [DllImport("ntdll.dll", EntryPoint = "NtClose", ExactSpelling = true)]
    internal static extern uint NtClose(nint handle);

    // -------------------------------------------------------------- kernel32

    [DllImport(
        "kernel32.dll",
        EntryPoint = "GetFinalPathNameByHandleW",
        ExactSpelling = true,
        CharSet = CharSet.Unicode,
        SetLastError = true)]
    internal static extern uint GetFinalPathNameByHandleW(
        nint file,
        [Out] char[] filePath,
        uint filePathLength,
        uint flags);

    [DllImport(
        "kernel32.dll",
        EntryPoint = "GetVolumeInformationByHandleW",
        ExactSpelling = true,
        CharSet = CharSet.Unicode,
        SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetVolumeInformationByHandleW(
        nint file,
        [Out] char[]? volumeNameBuffer,
        uint volumeNameSize,
        out uint volumeSerialNumber,
        out uint maximumComponentLength,
        out uint fileSystemFlags,
        [Out] char[]? fileSystemNameBuffer,
        uint fileSystemNameSize);

    [DllImport(
        "kernel32.dll",
        EntryPoint = "GetFileInformationByHandleEx",
        ExactSpelling = true,
        SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetFileInformationByHandleEx(
        nint file,
        int fileInformationClass,
        nint fileInformation,
        uint bufferSize);

    [DllImport("kernel32.dll", EntryPoint = "ReadFile", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool ReadFile(
        nint file,
        [Out] byte[] buffer,
        uint bytesToRead,
        out uint bytesRead,
        nint overlapped);

    [DllImport("kernel32.dll", EntryPoint = "WriteFile", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool WriteFile(
        nint file,
        byte[] buffer,
        uint bytesToWrite,
        out uint bytesWritten,
        nint overlapped);

    [DllImport("kernel32.dll", EntryPoint = "SetFilePointerEx", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool SetFilePointerEx(
        nint file,
        long distanceToMove,
        out long newFilePointer,
        uint moveMethod);

    [DllImport("kernel32.dll", EntryPoint = "FlushFileBuffers", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool FlushFileBuffers(nint file);

    [DllImport("kernel32.dll", EntryPoint = "GetCurrentProcess", ExactSpelling = true)]
    internal static extern nint GetCurrentProcess();

    [DllImport("kernel32.dll", EntryPoint = "CloseHandle", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CloseHandle(nint handle);

    [DllImport("kernel32.dll", EntryPoint = "LocalFree", ExactSpelling = true)]
    internal static extern nint LocalFree(nint memory);

    // -------------------------------------------------------------- advapi32

    [DllImport("advapi32.dll", EntryPoint = "GetSecurityInfo", ExactSpelling = true)]
    internal static extern uint GetSecurityInfo(
        nint handle,
        int objectType,
        uint securityInformation,
        out nint owner,
        out nint group,
        out nint dacl,
        out nint sacl,
        out nint securityDescriptor);

    [DllImport("advapi32.dll", EntryPoint = "GetSecurityDescriptorControl", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetSecurityDescriptorControl(
        nint securityDescriptor,
        out ushort control,
        out uint revision);

    [DllImport("advapi32.dll", EntryPoint = "GetAclInformation", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetAclInformation(
        nint acl,
        out ACL_SIZE_INFORMATION aclInformation,
        uint aclInformationLength,
        int aclInformationClass);

    [DllImport("advapi32.dll", EntryPoint = "GetAce", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetAce(nint acl, uint aceIndex, out nint ace);

    [DllImport(
        "advapi32.dll",
        EntryPoint = "ConvertSidToStringSidW",
        ExactSpelling = true,
        CharSet = CharSet.Unicode,
        SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool ConvertSidToStringSidW(nint sid, out nint stringSid);

    [DllImport(
        "advapi32.dll",
        EntryPoint = "ConvertStringSecurityDescriptorToSecurityDescriptorW",
        ExactSpelling = true,
        CharSet = CharSet.Unicode,
        SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(
        string stringSecurityDescriptor,
        uint stringSDRevision,
        out nint securityDescriptor,
        out uint securityDescriptorSize);

    [DllImport("advapi32.dll", EntryPoint = "OpenProcessToken", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool OpenProcessToken(nint process, uint desiredAccess, out nint token);

    [DllImport("advapi32.dll", EntryPoint = "GetTokenInformation", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetTokenInformation(
        nint token,
        int tokenInformationClass,
        nint tokenInformation,
        uint tokenInformationLength,
        out uint returnLength);

    [DllImport("advapi32.dll", EntryPoint = "DuplicateTokenEx", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool DuplicateTokenEx(
        nint existingToken,
        uint desiredAccess,
        nint tokenAttributes,
        int impersonationLevel,
        int tokenType,
        out nint newToken);

    [DllImport("advapi32.dll", EntryPoint = "AccessCheck", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool AccessCheck(
        nint securityDescriptor,
        nint clientToken,
        uint desiredAccess,
        ref GENERIC_MAPPING genericMapping,
        nint privilegeSet,
        ref uint privilegeSetLength,
        out uint grantedAccess,
        [MarshalAs(UnmanagedType.Bool)] out bool accessStatus);

    [DllImport("advapi32.dll", EntryPoint = "MapGenericMask", ExactSpelling = true)]
    internal static extern void MapGenericMask(ref uint accessMask, ref GENERIC_MAPPING genericMapping);

    // ---------------------------------------------------------------- shell32

    [DllImport(
        "shell32.dll",
        EntryPoint = "SHGetKnownFolderPath",
        ExactSpelling = true,
        CharSet = CharSet.Unicode)]
    internal static extern int SHGetKnownFolderPath(
        ref Guid folderId,
        uint flags,
        nint token,
        out nint path);

    [DllImport("ole32.dll", EntryPoint = "CoTaskMemFree", ExactSpelling = true)]
    internal static extern void CoTaskMemFree(nint memory);
}

/// <summary>
/// The real handle-relative filesystem: a thin, auditable adapter that turns
/// each <see cref="HandleRelativeOpenRequest"/> into exactly one native call
/// with exactly the requested flags.
///
/// The adapter is deliberately thin. Every decision — which flags, which
/// disposition, which order, what to refuse — lives in
/// <see cref="InstallTransaction"/> and is exercised by the read-only
/// self-test against <see cref="SimulatedFileSystem"/>. What lives here is only
/// the marshalling, so the part that cannot be tested without running it is as
/// small as it can be made.
///
/// NOTHING IN THIS FILE HAS BEEN EXECUTED. It compiles and it is reviewed; that
/// is all that may be claimed. ADR 0018 section 3 states the same rule for the
/// process-creation call sites and it applies identically here.
/// </summary>
internal sealed class NativeHandleRelativeFileSystem : HandleRelativeFileSystem, IDisposable
{
    private const int SE_FILE_OBJECT = 1;
    private const uint OWNER_SECURITY_INFORMATION = 0x00000001;
    private const uint GROUP_SECURITY_INFORMATION = 0x00000002;
    private const uint DACL_SECURITY_INFORMATION = 0x00000004;
    private const int FileAttributeTagInformation = 35;
    private const int FileDispositionInformationEx = 64;
    // FILE_INFO_BY_HANDLE_CLASS, the enum GetFileInformationByHandleEx takes.
    //
    // These were 3 and 2 — FILE_INFORMATION_CLASS values, which belong to
    // NtQueryDirectoryFile. In the class GetFileInformationByHandleEx actually
    // uses, 2 is FileNameInfo and 3 is FileRenameInfo, which is SET-only. The
    // struct offsets below were correct for FILE_FULL_DIR_INFO, which is what
    // isolated the defect to these two ordinals rather than the parsing.
    private const int FileStandardInfo = 1;
    private const int FileIdInfo = 18;
    private const int FileFullDirectoryInfo = 14;
    private const int FileFullDirectoryRestartInfo = 15;
    private const int ERROR_NO_MORE_FILES = 18;
    private const uint FILE_BEGIN = 0;

    // The ordinals above, readable by the conformance suite so it can pin them
    // against the SDK values a reviewer can look up. Reading a constant does not
    // construct this type, which is what the instantiation counter proves.
    internal static int FileStandardInfoClass => FileStandardInfo;

    internal static int FileIdInfoClass => FileIdInfo;

    internal static int FileFullDirectoryInfoClass => FileFullDirectoryInfo;

    internal static int FileFullDirectoryRestartInfoClass => FileFullDirectoryRestartInfo;

    internal static int NoMoreFilesError => ERROR_NO_MORE_FILES;
    private const uint FILE_DISPOSITION_DELETE = 0x00000001;
    private const uint FILE_DISPOSITION_POSIX_SEMANTICS = 0x00000002;
    private const uint FILE_NAME_NORMALIZED = 0x00000000;
    private const uint VOLUME_NAME_DOS = 0x00000000;
    private const uint TOKEN_QUERY = 0x0008;
    private const uint TOKEN_DUPLICATE = 0x0002;
    private const uint TOKEN_IMPERSONATE = 0x0004;
    private const int TokenUser = 1;
    private const int TokenElevation = 20;
    private const int TokenLinkedToken = 19;
    private const int SecurityIdentification = 2;
    private const int TokenImpersonation = 2;
    private const uint SDDL_REVISION_1 = 1;
    private const uint KF_FLAG_NO_ALIAS = 0x00001000;
    private const uint KF_FLAG_DONT_VERIFY = 0x00004000;
    private const int MaximumDirectoryEntries = 4_096;
    private const int DirectoryBufferBytes = 65_536;

    /// <summary>FOLDERID_ProgramData.</summary>
    private static readonly Guid FolderIdProgramData =
        new("62AB5D82-FDC1-4DC3-A9DD-070D1D495D97");

    /// <summary>
    /// How many times this type has been constructed in this process, and how
    /// many native opens it has attempted.
    ///
    /// They exist because a vector asserting "the self-test never instantiates
    /// the native filesystem" compared the literal "true" to the literal "true"
    /// — the same tautology the release evidence records as F2 and that this
    /// component's own comments cite twice as the thing being avoided. A claim
    /// about what the self-test did has to be a measurement of what the
    /// self-test did.
    /// </summary>
    private static int instantiationCount;
    private static int nativeOpenAttemptCount;

    internal static int InstantiationCount => Volatile.Read(ref instantiationCount);

    internal static int NativeOpenAttemptCount => Volatile.Read(ref nativeOpenAttemptCount);

    internal NativeHandleRelativeFileSystem() => Interlocked.Increment(ref instantiationCount);

    private readonly List<CanonicalObject> log = [];
    private readonly Dictionary<long, nint> handles = [];
    private nint standardToken;
    private bool standardTokenResolved;
    private string standardTokenKind = "unresolved";
    private bool disposed;

    public override IReadOnlyList<CanonicalObject> OperationLog => log;

    // ------------------------------------------------------------- resolution

    public override Outcome<KnownFolderResolution> ResolveCommonApplicationData()
    {
        Record("resolve-known-folder", "SHGetKnownFolderPath(FOLDERID_ProgramData)");
        Guid folder = FolderIdProgramData;
        int hr = NativeMethods.SHGetKnownFolderPath(
            ref folder,
            KF_FLAG_NO_ALIAS | KF_FLAG_DONT_VERIFY,
            0,
            out nint buffer);
        if (hr != 0 || buffer == 0)
        {
            return Outcome<KnownFolderResolution>.Refused(RefusalCode.KnownFolderUnresolvable);
        }

        string? path;
        try
        {
            path = Marshal.PtrToStringUni(buffer);
        }
        finally
        {
            NativeMethods.CoTaskMemFree(buffer);
        }

        if (path is null)
        {
            return Outcome<KnownFolderResolution>.Refused(RefusalCode.KnownFolderUnresolvable);
        }

        RefusalCode parsed = NameGrammar.TryParseDriveRootedPath(
            path,
            out char drive,
            out IReadOnlyList<string> components);
        if (parsed != RefusalCode.None)
        {
            // The known folder came back in a spelling this component does not
            // accept — a UNC path, a device path, or a component outside the
            // closed grammar. That is a refusal, not something to normalise:
            // normalising an unexpected spelling is how the second spelling
            // becomes the accepted one.
            return Outcome<KnownFolderResolution>.Refused(
                RefusalCode.KnownFolderPathNotDriveRooted);
        }

        return Outcome<KnownFolderResolution>.Success(
            new KnownFolderResolution(path, drive, components));
    }

    public override Outcome<ProofIdentity> ResolveProofIdentity()
    {
        Record("resolve-proof-identity", "OpenProcessToken+GetTokenInformation(TokenUser)");
        if (!NativeMethods.OpenProcessToken(
                NativeMethods.GetCurrentProcess(),
                TOKEN_QUERY | TOKEN_DUPLICATE,
                out nint token) || token == 0)
        {
            return Outcome<ProofIdentity>.Refused(RefusalCode.StandardTokenUnavailable);
        }

        try
        {
            Outcome<string> sid = ReadTokenUserSid(token);
            if (!sid.Ok || sid.Value is null)
            {
                return Outcome<ProofIdentity>.Refused(sid.Refusal);
            }

            return Outcome<ProofIdentity>.Success(
                new ProofIdentity(sid.Value, WellKnownSids.IsWellKnownPrivileged(sid.Value)));
        }
        finally
        {
            _ = NativeMethods.CloseHandle(token);
        }
    }

    // ------------------------------------------------------------------ opens

    protected override RefusalCode OpenVolumeRootCore(
        char driveLetter,
        HandleRelativeOpenRequest request,
        long ordinal)
    {
        // The single absolute open of the transaction. \GLOBAL?? rather than
        // \?? so a per-logon-session device map cannot supply the drive letter;
        // see OpenRequests.VolumeRootObjectAttributes for why OBJ_DONT_REPARSE
        // cannot be set on this one open and what bounds that exception.
        string ntPath = string.Create(CultureInfo.InvariantCulture, $"\\GLOBAL??\\{driveLetter}:\\");
        return Open(null, ntPath, request, "open-volume-root", ordinal);
    }

    protected override RefusalCode OpenRelativeCore(
        OpenedObject parent,
        HandleRelativeOpenRequest request,
        long ordinal)
    {
        // The base class has already enforced the name grammar and that the
        // parent handle object is open. What is left is this adapter's own
        // question: do WE still hold a native handle for it?
        if (!handles.TryGetValue(parent.Ordinal, out nint parentHandle))
        {
            return RefusalCode.AncestorHandleNotRetained;
        }

        return Open(parentHandle, request.Name, request, "open-relative", ordinal);
    }

    /// <summary>
    /// Marshals one request and reports only whether it worked.
    ///
    /// It deliberately does not return a handle object. Building one, and
    /// linking it to its parent, belongs to the shared base class, so this
    /// adapter cannot be the place where the ancestor chain silently becomes
    /// a single link.
    /// </summary>
    private RefusalCode Open(
        nint? rootDirectory,
        string objectName,
        HandleRelativeOpenRequest request,
        string operation,
        long ordinal)
    {
        Record(operation, CanonicalJson.SerializeToString(request.ToCanonical()));
        _ = Interlocked.Increment(ref nativeOpenAttemptCount);

        nint namePointer = 0;
        nint unicodeStringPointer = 0;
        nint securityDescriptor = 0;
        try
        {
            if (request.SecurityDescriptor is not null)
            {
                if (!NativeMethods.ConvertStringSecurityDescriptorToSecurityDescriptorW(
                        request.SecurityDescriptor.Sddl,
                        SDDL_REVISION_1,
                        out securityDescriptor,
                        out _) || securityDescriptor == 0)
                {
                    return RefusalCode.SecurityDescriptorCompositionFailed;
                }
            }
            else if (request.IsCreateOnly)
            {
                // Creating without a descriptor would produce an object with the
                // creator's default DACL, to be repaired afterwards. The repair
                // window is the vulnerability, so the create is refused instead.
                return RefusalCode.SecurityDescriptorNotSuppliedAtCreation;
            }

            namePointer = Marshal.StringToHGlobalUni(objectName);
            int nameBytes = checked(objectName.Length * 2);
            NativeMethods.UNICODE_STRING unicodeName = new()
            {
                Length = checked((ushort)nameBytes),
                MaximumLength = checked((ushort)nameBytes),
                Buffer = namePointer,
            };
            unicodeStringPointer = Marshal.AllocHGlobal(
                Marshal.SizeOf<NativeMethods.UNICODE_STRING>());
            Marshal.StructureToPtr(unicodeName, unicodeStringPointer, fDeleteOld: false);

            NativeMethods.OBJECT_ATTRIBUTES attributes = new()
            {
                Length = Marshal.SizeOf<NativeMethods.OBJECT_ATTRIBUTES>(),
                RootDirectory = rootDirectory ?? 0,
                ObjectName = unicodeStringPointer,
                Attributes = request.ObjectAttributes,
                SecurityDescriptor = securityDescriptor,
                SecurityQualityOfService = 0,
            };

            uint status = NativeMethods.NtCreateFile(
                out nint handle,
                request.DesiredAccess,
                ref attributes,
                out NativeMethods.IO_STATUS_BLOCK _,
                0,
                request.FileAttributes,
                request.ShareAccess,
                request.CreateDisposition,
                request.CreateOptions,
                0,
                0);

            if (!NtStatusCodes.Succeeded(status))
            {
                return NtStatusCodes.Classify(status);
            }

            if (status == NtStatusCodes.STATUS_REPARSE)
            {
                // An informational success that means the open was redirected.
                // With OBJ_DONT_REPARSE set this should be unreachable; it is
                // still refused, because "should be unreachable" and "is
                // unreachable" are different propositions and only one of them
                // is checkable here.
                _ = NativeMethods.NtClose(handle);
                return RefusalCode.NativeReparsePointEncountered;
            }

            // Register against the ordinal the BASE allocated. The handle
            // object and its parent link are the base class's to build; this
            // adapter is never asked what the parent was, so it cannot answer
            // wrongly.
            handles[ordinal] = handle;
            return RefusalCode.None;
        }
        catch (OverflowException)
        {
            return RefusalCode.ComponentNameInvalid;
        }
        finally
        {
            if (securityDescriptor != 0)
            {
                _ = NativeMethods.LocalFree(securityDescriptor);
            }

            if (unicodeStringPointer != 0)
            {
                Marshal.FreeHGlobal(unicodeStringPointer);
            }

            if (namePointer != 0)
            {
                Marshal.FreeHGlobal(namePointer);
            }
        }
    }


    // ------------------------------------------------------------- inspection

    public override Outcome<ObjectFacts> QueryFacts(OpenedObject handle)
    {
        ArgumentNullException.ThrowIfNull(handle);
        Record("query-facts", "NtQueryInformationFile(FileAttributeTagInformation)+FileIdInfo+GetFinalPathNameByHandleW");
        if (!handle.IsOpen || !handles.TryGetValue(handle.Ordinal, out nint raw))
        {
            return Outcome<ObjectFacts>.Refused(RefusalCode.NativeInvalidHandle);
        }

        nint buffer = Marshal.AllocHGlobal(
            Marshal.SizeOf<NativeMethods.FILE_ATTRIBUTE_TAG_INFORMATION>());
        uint attributes;
        uint reparseTag;
        try
        {
            uint status = NativeMethods.NtQueryInformationFile(
                raw,
                out NativeMethods.IO_STATUS_BLOCK _,
                buffer,
                checked((uint)Marshal.SizeOf<NativeMethods.FILE_ATTRIBUTE_TAG_INFORMATION>()),
                FileAttributeTagInformation);
            if (!NtStatusCodes.Succeeded(status))
            {
                return Outcome<ObjectFacts>.Refused(NtStatusCodes.Classify(status));
            }

            NativeMethods.FILE_ATTRIBUTE_TAG_INFORMATION tag =
                Marshal.PtrToStructure<NativeMethods.FILE_ATTRIBUTE_TAG_INFORMATION>(buffer);
            attributes = tag.FileAttributes;
            reparseTag = tag.ReparseTag;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }

        // FILE_ID_INFO: ULONGLONG VolumeSerialNumber; FILE_ID_128 FileId (16 bytes).
        const int fileIdInfoBytes = 24;
        nint idBuffer = Marshal.AllocHGlobal(fileIdInfoBytes);
        ulong volumeSerial;
        StringBuilder fileId = new(32);
        try
        {
            if (!NativeMethods.GetFileInformationByHandleEx(raw, FileIdInfo, idBuffer, fileIdInfoBytes))
            {
                return Outcome<ObjectFacts>.Refused(RefusalCode.ComponentIdentityMismatch);
            }

            volumeSerial = unchecked((ulong)Marshal.ReadInt64(idBuffer));
            for (int index = 0; index < 16; index++)
            {
                fileId.Append(Marshal.ReadByte(idBuffer, 8 + index)
                    .ToString("x2", CultureInfo.InvariantCulture));
            }
        }
        finally
        {
            Marshal.FreeHGlobal(idBuffer);
        }

        char[] pathBuffer = new char[1024];
        uint written = NativeMethods.GetFinalPathNameByHandleW(
            raw,
            pathBuffer,
            checked((uint)pathBuffer.Length),
            FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
        if (written == 0 || written >= pathBuffer.Length)
        {
            return Outcome<ObjectFacts>.Refused(RefusalCode.ComponentFinalPathMismatch);
        }

        string finalPath = new(pathBuffer, 0, checked((int)written));

        // GetFinalPathNameByHandleW returns the \\?\ form. It is stripped for
        // comparison and nothing is ever re-opened from the result: the value
        // is evidence about the handle, not an input to a subsequent open.
        if (finalPath.StartsWith("\\\\?\\", StringComparison.Ordinal))
        {
            finalPath = finalPath[4..];
        }

        char[] fileSystemName = new char[64];
        if (!NativeMethods.GetVolumeInformationByHandleW(
                raw,
                null,
                0,
                out uint _,
                out uint _,
                out uint _,
                fileSystemName,
                checked((uint)fileSystemName.Length)))
        {
            return Outcome<ObjectFacts>.Refused(RefusalCode.VolumeFilesystemUnsupported);
        }

        long endOfFile = 0;
        if ((attributes & NtFlags.FILE_ATTRIBUTE_DIRECTORY) == 0)
        {
            // Through the SAME named-constant helper the measurement uses, and a
            // failed query is a REFUSAL.
            //
            // Two defects were fixed here at once, both of the kind this component
            // eradicates elsewhere. The information class was a raw literal `1`,
            // so the vector pinning `FileStandardInfoClass` did not govern this
            // call site. And a FALSE return left `endOfFile` at 0, which is a
            // benign-looking answer to a question that failed: a size of zero
            // vacuously satisfies the pre-read maximum-size gate in
            // MeasureSourceClosure, so a file whose size could not be read would
            // pass a check that exists to bound it.
            RefusalCode sized = TryReportedSize(raw, out endOfFile);
            if (sized != RefusalCode.None)
            {
                return Outcome<ObjectFacts>.Refused(sized);
            }
        }

        return Outcome<ObjectFacts>.Success(new ObjectFacts(
            (attributes & NtFlags.FILE_ATTRIBUTE_DIRECTORY) != 0,
            (attributes & NtFlags.FILE_ATTRIBUTE_REPARSE_POINT) != 0,
            reparseTag,
            unchecked((uint)volumeSerial),
            fileId.ToString(),
            TrimNul(finalPath),
            TrimNul(new string(fileSystemName)),
            endOfFile));
    }

    public override Outcome<SecuritySnapshot> QuerySecurity(OpenedObject handle)
    {
        ArgumentNullException.ThrowIfNull(handle);
        Record("query-security", "GetSecurityInfo(handle,SE_FILE_OBJECT,OWNER|GROUP|DACL)");
        if (!handle.IsOpen || !handles.TryGetValue(handle.Ordinal, out nint raw))
        {
            return Outcome<SecuritySnapshot>.Refused(RefusalCode.NativeInvalidHandle);
        }

        uint error = NativeMethods.GetSecurityInfo(
            raw,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            out nint ownerSid,
            out nint _,
            out nint dacl,
            out nint _,
            out nint descriptor);
        if (error != 0 || descriptor == 0)
        {
            return Outcome<SecuritySnapshot>.Refused(RefusalCode.SecurityDescriptorUnavailable);
        }

        try
        {
            if (!NativeMethods.GetSecurityDescriptorControl(descriptor, out ushort control, out uint _))
            {
                return Outcome<SecuritySnapshot>.Refused(RefusalCode.SecurityDescriptorUnavailable);
            }

            Outcome<string> owner = SidToString(ownerSid);
            if (!owner.Ok || owner.Value is null)
            {
                return Outcome<SecuritySnapshot>.Refused(RefusalCode.SecurityDescriptorUnavailable);
            }

            List<AceSnapshot> aces = [];
            if (dacl != 0 &&
                NativeMethods.GetAclInformation(
                    dacl,
                    out NativeMethods.ACL_SIZE_INFORMATION size,
                    checked((uint)Marshal.SizeOf<NativeMethods.ACL_SIZE_INFORMATION>()),
                    2))
            {
                for (uint index = 0; index < size.AceCount; index++)
                {
                    if (!NativeMethods.GetAce(dacl, index, out nint ace) || ace == 0)
                    {
                        return Outcome<SecuritySnapshot>.Refused(
                            RefusalCode.SecurityDescriptorUnavailable);
                    }

                    NativeMethods.ACE_HEADER header =
                        Marshal.PtrToStructure<NativeMethods.ACE_HEADER>(ace);

                    // Only the two ACE types this component understands are
                    // accepted. An object-type or callback ACE has a different
                    // layout, so reading a SID at the fixed offset would read
                    // the wrong bytes and silently produce a wrong verdict.
                    if (header.AceType != NtFlags.ACCESS_ALLOWED_ACE_TYPE &&
                        header.AceType != NtFlags.ACCESS_DENIED_ACE_TYPE)
                    {
                        return Outcome<SecuritySnapshot>.Refused(RefusalCode.DaclUnexpectedAce);
                    }

                    uint mask = unchecked((uint)Marshal.ReadInt32(ace, 4));
                    Outcome<string> sid = SidToString(ace + 8);
                    if (!sid.Ok || sid.Value is null)
                    {
                        return Outcome<SecuritySnapshot>.Refused(
                            RefusalCode.SecurityDescriptorUnavailable);
                    }

                    aces.Add(new AceSnapshot(header.AceType, header.AceFlags, mask, sid.Value));
                }
            }

            return Outcome<SecuritySnapshot>.Success(
                new SecuritySnapshot(owner.Value, control, dacl != 0, aces));
        }
        finally
        {
            _ = NativeMethods.LocalFree(descriptor);
        }
    }

    public override Outcome<AccessCheckResult> AccessCheckAsProofIdentity(OpenedObject handle)
    {
        ArgumentNullException.ThrowIfNull(handle);
        Record("access-check", "AccessCheck(MAXIMUM_ALLOWED, standard token)");
        if (!handle.IsOpen || !handles.TryGetValue(handle.Ordinal, out nint raw))
        {
            return Outcome<AccessCheckResult>.Refused(RefusalCode.NativeInvalidHandle);
        }

        RefusalCode token = EnsureStandardToken();
        if (token != RefusalCode.None)
        {
            return Outcome<AccessCheckResult>.Refused(token);
        }

        uint error = NativeMethods.GetSecurityInfo(
            raw,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            out nint _,
            out nint _,
            out nint _,
            out nint _,
            out nint descriptor);
        if (error != 0 || descriptor == 0)
        {
            return Outcome<AccessCheckResult>.Refused(RefusalCode.SecurityDescriptorUnavailable);
        }

        nint privileges = Marshal.AllocHGlobal(256);
        try
        {
            NativeMethods.GENERIC_MAPPING mapping = new()
            {
                GenericRead = NtFlags.FILE_GENERIC_READ,
                GenericWrite = NtFlags.FILE_GENERIC_WRITE,
                GenericExecute = NtFlags.FILE_GENERIC_EXECUTE,
                GenericAll = NtFlags.FILE_ALL_ACCESS,
            };
            uint desired = NtFlags.MAXIMUM_ALLOWED;
            NativeMethods.MapGenericMask(ref desired, ref mapping);
            uint privilegeLength = 256;

            if (!NativeMethods.AccessCheck(
                    descriptor,
                    standardToken,
                    desired,
                    ref mapping,
                    privileges,
                    ref privilegeLength,
                    out uint granted,
                    out bool _))
            {
                return Outcome<AccessCheckResult>.Refused(RefusalCode.AccessCheckUnavailable);
            }

            // With MAXIMUM_ALLOWED the granted mask is the answer regardless of
            // the boolean, which reports whether the (zero) desired access was
            // granted. Reading the boolean instead of the mask would report
            // success on a directory the identity can fully control.
            return Outcome<AccessCheckResult>.Success(
                new AccessCheckResult(granted, standardTokenKind));
        }
        finally
        {
            Marshal.FreeHGlobal(privileges);
            _ = NativeMethods.LocalFree(descriptor);
        }
    }

    public override Outcome<DirectoryListing> ListDirectory(OpenedObject handle)
    {
        ArgumentNullException.ThrowIfNull(handle);
        Record("list-directory", "GetFileInformationByHandleEx(FileFullDirectoryInfo)");
        if (!handle.IsOpen || !handles.TryGetValue(handle.Ordinal, out nint raw))
        {
            return Outcome<DirectoryListing>.Refused(RefusalCode.NativeInvalidHandle);
        }

        List<string> files = [];
        List<string> directories = [];
        nint buffer = Marshal.AllocHGlobal(DirectoryBufferBytes);
        try
        {
            int informationClass = FileFullDirectoryRestartInfo;
            while (true)
            {
                if (!NativeMethods.GetFileInformationByHandleEx(
                        raw,
                        informationClass,
                        buffer,
                        DirectoryBufferBytes))
                {
                    // A FALSE return is END OF ENUMERATION only when the
                    // last error says so. Treating every FALSE as the end
                    // made a failed enumeration indistinguishable from an
                    // empty directory, which turned four separate guards
                    // into no-ops at once: the source extra-file and
                    // case-duplicate scan, the destination extra-entry scan,
                    // and removal's refusal of unexpected entries and its
                    // proof that a directory is empty. An enumeration this
                    // component cannot complete is a refusal, never an
                    // empty answer.
                    int error = Marshal.GetLastWin32Error();
                    return error == ERROR_NO_MORE_FILES
                        ? Finish(files, directories)
                        : Outcome<DirectoryListing>.Refused(
                            error == 5
                                ? RefusalCode.NativeAccessDenied
                                : RefusalCode.NativeUnexpectedFailure);
                }

                informationClass = FileFullDirectoryInfo;
                nint entry = buffer;
                while (true)
                {
                    int nextOffset = Marshal.ReadInt32(entry, 0);
                    uint attributes = unchecked((uint)Marshal.ReadInt32(entry, 56));
                    int nameLength = Marshal.ReadInt32(entry, 60);
                    if (nameLength < 0 || nameLength > 2 * NameGrammar.MaximumNameLength * 4)
                    {
                        return Outcome<DirectoryListing>.Refused(RefusalCode.ComponentNameInvalid);
                    }

                    string name = Marshal.PtrToStringUni(entry + 68, nameLength / 2);
                    if (!string.Equals(name, ".", StringComparison.Ordinal) &&
                        !string.Equals(name, "..", StringComparison.Ordinal))
                    {
                        if ((attributes & NtFlags.FILE_ATTRIBUTE_DIRECTORY) != 0)
                        {
                            directories.Add(name);
                        }
                        else
                        {
                            files.Add(name);
                        }
                    }

                    if (files.Count + directories.Count > MaximumDirectoryEntries)
                    {
                        return Outcome<DirectoryListing>.Refused(RefusalCode.NativeResourceExhausted);
                    }

                    if (nextOffset == 0)
                    {
                        break;
                    }

                    entry += nextOffset;
                }
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static Outcome<DirectoryListing> Finish(List<string> files, List<string> directories)
    {
        files.Sort(StringComparer.Ordinal);
        directories.Sort(StringComparer.Ordinal);
        return Outcome<DirectoryListing>.Success(new DirectoryListing(files, directories));
    }

    public override RefusalCode RewindToStart(OpenedObject handle)
    {
        ArgumentNullException.ThrowIfNull(handle);
        Record("rewind-to-start", "SetFilePointerEx to FILE_BEGIN");
        if (!handle.IsOpen || !handles.TryGetValue(handle.Ordinal, out nint raw))
        {
            return RefusalCode.NativeInvalidHandle;
        }

        return NativeMethods.SetFilePointerEx(raw, 0, out long moved, FILE_BEGIN) && moved == 0
            ? RefusalCode.None
            : RefusalCode.NativeUnexpectedFailure;
    }

    public override Outcome<FileMeasurement> MeasureFile(OpenedObject handle)
    {
        ArgumentNullException.ThrowIfNull(handle);

        // Recorded as ONE operation, and the read it performs internally is
        // deliberately not recorded as a second. The simulated filesystem logs
        // exactly one entry here, and an operation log that disagrees between
        // the two implementations would make the pinned install sequence a
        // statement about the simulation rather than about the contract — the
        // same class of divergence as the ancestor link the adapter did not
        // supply.
        Record("measure-file", "ReadFile(handle) to EOF then SHA-256, cross-checked against FileStandardInfo");
        if (!handle.IsOpen || !handles.TryGetValue(handle.Ordinal, out nint raw))
        {
            return Outcome<FileMeasurement>.Refused(RefusalCode.NativeInvalidHandle);
        }

        Outcome<byte[]> bytes = ReadToEnd(
            raw,
            checked((int)ProofConfiguration.MaximumInstalledFileBytes));
        if (!bytes.Ok || bytes.Value is null)
        {
            return Outcome<FileMeasurement>.Refused(bytes.Refusal);
        }

        // Provenance is a CROSS-CHECK, not a literal. The size is read back
        // through the same handle that was just hashed, and the two have to
        // agree. A hardcoded `true` here is what made the refusal it feeds
        // unreachable in the real path, and it is also what would have hidden
        // the offset defect: hashing zero bytes of a non-empty file is
        // precisely the disagreement this now detects.
        RefusalCode sized = TryReportedSize(raw, out long reported);
        if (sized != RefusalCode.None)
        {
            return Outcome<FileMeasurement>.Refused(sized);
        }

        return Outcome<FileMeasurement>.Success(new FileMeasurement(
            bytes.Value.LongLength,
            ProofConfiguration.Sha256Hex(bytes.Value),
            measuredThroughHandle: bytes.Value.LongLength == reported));
    }

    /// <summary>
    /// The size this exact handle reports, via <c>FileStandardInfo</c>.
    ///
    /// <c>Outcome&lt;T&gt;</c> is constrained to reference types on purpose — a
    /// refusal must never be confused with a default value — so a size is
    /// returned the way every other refusal-or-value primitive in this file
    /// returns one: the refusal is the return value and the size is an out
    /// parameter that is only meaningful when the refusal is
    /// <see cref="RefusalCode.None"/>.
    /// </summary>
    private static RefusalCode TryReportedSize(nint raw, out long size)
    {
        size = 0;

        // FILE_STANDARD_INFO: AllocationSize (8), EndOfFile (8), NumberOfLinks
        // (4), DeletePending (1), Directory (1), plus two bytes of tail padding
        // to the 8-byte alignment of the leading Int64 members.
        const int standardInfoBytes = 24;
        const int endOfFileOffset = 8;
        nint standard = Marshal.AllocHGlobal(standardInfoBytes);
        try
        {
            if (!NativeMethods.GetFileInformationByHandleEx(
                    raw,
                    FileStandardInfo,
                    standard,
                    standardInfoBytes))
            {
                return RefusalCode.NativeUnexpectedFailure;
            }

            size = Marshal.ReadInt64(standard, endOfFileOffset);
            return RefusalCode.None;
        }
        finally
        {
            Marshal.FreeHGlobal(standard);
        }
    }

    public override Outcome<byte[]> ReadThroughHandle(OpenedObject handle, int maximumBytes)
    {
        ArgumentNullException.ThrowIfNull(handle);
        Record("read-through-handle", "ReadFile(handle)");
        if (!handle.IsOpen || !handles.TryGetValue(handle.Ordinal, out nint raw))
        {
            return Outcome<byte[]>.Refused(RefusalCode.NativeInvalidHandle);
        }

        return ReadToEnd(raw, maximumBytes);
    }

    /// <summary>
    /// Reads from the handle's CURRENT offset to end of file.
    ///
    /// It starts wherever the last operation left the offset, and does not
    /// silently rewind. That is why <see cref="RewindToStart"/> exists as a
    /// contract operation the caller has to ask for: a hidden rewind here would
    /// make the missing-rewind defect invisible to a simulation, which is
    /// precisely how the defect survived review the first time.
    /// </summary>
    private static Outcome<byte[]> ReadToEnd(nint raw, int maximumBytes)
    {
        using MemoryStream accumulated = new();
        byte[] chunk = new byte[65_536];
        long total = 0;
        while (true)
        {
            if (!NativeMethods.ReadFile(
                    raw,
                    chunk,
                    checked((uint)chunk.Length),
                    out uint read,
                    0))
            {
                return Outcome<byte[]>.Refused(RefusalCode.NativeUnexpectedFailure);
            }

            if (read == 0)
            {
                break;
            }

            total += read;
            if (total > maximumBytes)
            {
                return Outcome<byte[]>.Refused(RefusalCode.SourceFileSizeMismatch);
            }

            accumulated.Write(chunk, 0, checked((int)read));
        }

        return Outcome<byte[]>.Success(accumulated.ToArray());
    }

    public override Outcome<FileMeasurement> WriteThroughHandle(OpenedObject handle, byte[] content)
    {
        ArgumentNullException.ThrowIfNull(handle);
        ArgumentNullException.ThrowIfNull(content);
        Record("write-through-handle", "WriteFile(handle)");
        if (!handle.IsOpen || !handles.TryGetValue(handle.Ordinal, out nint raw))
        {
            return Outcome<FileMeasurement>.Refused(RefusalCode.NativeInvalidHandle);
        }

        if (content.Length > 0 &&
            (!NativeMethods.WriteFile(raw, content, checked((uint)content.Length), out uint written, 0) ||
             written != content.Length))
        {
            return Outcome<FileMeasurement>.Refused(RefusalCode.NativeUnexpectedFailure);
        }

        // This digest describes the BUFFER, not the file. Reporting it as
        // measured-through-the-handle would be a claim that hashing the array
        // you just handed the kernel proves what landed on disk, which it does
        // not. Verification is a separate read through a freshly opened handle.
        return Outcome<FileMeasurement>.Success(new FileMeasurement(
            content.LongLength,
            ProofConfiguration.Sha256Hex(content),
            measuredThroughHandle: false));
    }

    public override RefusalCode FlushBuffers(OpenedObject handle)
    {
        ArgumentNullException.ThrowIfNull(handle);
        Record("flush-buffers", "FlushFileBuffers(handle)");
        if (!handle.IsOpen || !handles.TryGetValue(handle.Ordinal, out nint raw))
        {
            return RefusalCode.NativeInvalidHandle;
        }

        // A flush failure is not a delete failure. Reporting one as the other
        // sends a reviewer looking at the removal path for a fault that happened
        // while writing.
        return NativeMethods.FlushFileBuffers(raw)
            ? RefusalCode.None
            : RefusalCode.NativeUnexpectedFailure;
    }

    public override RefusalCode DeleteThroughHandle(OpenedObject handle)
    {
        ArgumentNullException.ThrowIfNull(handle);
        Record("delete-through-handle", "NtSetInformationFile(FileDispositionInformationEx)");
        if (!handle.IsOpen || !handles.TryGetValue(handle.Ordinal, out nint raw))
        {
            return RefusalCode.NativeInvalidHandle;
        }

        nint buffer = Marshal.AllocHGlobal(
            Marshal.SizeOf<NativeMethods.FILE_DISPOSITION_INFORMATION_EX>());
        try
        {
            NativeMethods.FILE_DISPOSITION_INFORMATION_EX disposition = new()
            {
                Flags = FILE_DISPOSITION_DELETE | FILE_DISPOSITION_POSIX_SEMANTICS,
            };
            Marshal.StructureToPtr(disposition, buffer, fDeleteOld: false);
            uint status = NativeMethods.NtSetInformationFile(
                raw,
                out NativeMethods.IO_STATUS_BLOCK _,
                buffer,
                checked((uint)Marshal.SizeOf<NativeMethods.FILE_DISPOSITION_INFORMATION_EX>()),
                FileDispositionInformationEx);

            // No fallback to the older FileDispositionInformation and no
            // fallback to a path-based delete. ADR 0018 section 2.2 names "no
            // fallback path that quietly reverts to a path-based API" as one of
            // the conditions the guarantee depends on, so an unsupported
            // disposition is a refusal.
            return NtStatusCodes.Succeeded(status)
                ? RefusalCode.None
                : NtStatusCodes.Classify(status) == RefusalCode.NativeNotSupported
                    ? RefusalCode.DeleteUnsupported
                    : NtStatusCodes.Classify(status);
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    public override void CloseHandle(OpenedObject handle)
    {
        ArgumentNullException.ThrowIfNull(handle);
        if (handles.Remove(handle.Ordinal, out nint raw) && raw != 0)
        {
            _ = NativeMethods.NtClose(raw);
        }
    }

    public void Dispose()
    {
        if (disposed)
        {
            return;
        }

        disposed = true;
        foreach (KeyValuePair<long, nint> entry in handles)
        {
            if (entry.Value != 0)
            {
                _ = NativeMethods.NtClose(entry.Value);
            }
        }

        handles.Clear();
        if (standardToken != 0)
        {
            _ = NativeMethods.CloseHandle(standardToken);
            standardToken = 0;
        }
    }

    // ---------------------------------------------------------------- tokens

    /// <summary>
    /// Obtains an impersonation token representing the UNELEVATED proof
    /// identity.
    ///
    /// This is the part of the protection check most likely to be got wrong in
    /// a way that produces a green result. An elevated process's own token has
    /// <c>BUILTIN\Administrators</c> enabled, so an <c>AccessCheck</c> against
    /// it reports FullControl on a correctly protected directory and the
    /// assertion inverts: the check passes when the protection is right AND
    /// when it is wrong. The linked (filtered) token of an elevated process is
    /// the standard-user token the same human logs on with, and it is what the
    /// check must run against.
    ///
    /// There is no fallback. If the process is elevated and no linked token can
    /// be obtained, the check refuses rather than silently checking the wrong
    /// principal.
    /// </summary>
    private RefusalCode EnsureStandardToken()
    {
        if (standardTokenResolved)
        {
            return standardToken == 0 ? RefusalCode.StandardTokenUnavailable : RefusalCode.None;
        }

        standardTokenResolved = true;
        if (!NativeMethods.OpenProcessToken(
                NativeMethods.GetCurrentProcess(),
                TOKEN_QUERY | TOKEN_DUPLICATE,
                out nint process) || process == 0)
        {
            return RefusalCode.StandardTokenUnavailable;
        }

        nint source = 0;
        try
        {
            // A FAILED elevation query is not evidence of non-elevation.
            // Treating it as such is how an elevated token gets labelled
            // standard-user and an AccessCheck that should fail passes with
            // FullControl on a correctly protected directory.
            if (!TryReadTokenElevation(process, out bool elevated))
            {
                return RefusalCode.StandardTokenUnavailable;
            }

            if (elevated)
            {
                nint buffer = Marshal.AllocHGlobal(nint.Size);
                try
                {
                    if (!NativeMethods.GetTokenInformation(
                            process,
                            TokenLinkedToken,
                            buffer,
                            checked((uint)nint.Size),
                            out uint _))
                    {
                        return RefusalCode.StandardTokenUnavailable;
                    }

                    source = Marshal.ReadIntPtr(buffer);
                }
                finally
                {
                    Marshal.FreeHGlobal(buffer);
                }

                if (source == 0)
                {
                    return RefusalCode.StandardTokenUnavailable;
                }
            }
            else
            {
                source = process;
            }

            if (!NativeMethods.DuplicateTokenEx(
                    source,
                    TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_IMPERSONATE,
                    0,
                    SecurityIdentification,
                    TokenImpersonation,
                    out nint impersonation) || impersonation == 0)
            {
                return RefusalCode.StandardTokenUnavailable;
            }

            // The label is derived from an OBSERVATION of the token that will
            // actually be checked against, not assigned by whichever branch
            // produced it. A label the code writes is a label the code can be
            // wrong about; a label read back from the object cannot disagree
            // with the object.
            if (!TryReadTokenElevation(impersonation, out bool duplicateElevated))
            {
                _ = NativeMethods.CloseHandle(impersonation);
                return RefusalCode.StandardTokenUnavailable;
            }

            if (duplicateElevated)
            {
                _ = NativeMethods.CloseHandle(impersonation);
                standardTokenKind = "elevated";
                return RefusalCode.StandardTokenUnavailable;
            }

            standardTokenKind = "standard-user";
            standardToken = impersonation;
            return RefusalCode.None;
        }
        finally
        {
            if (source != 0 && source != process)
            {
                _ = NativeMethods.CloseHandle(source);
            }

            _ = NativeMethods.CloseHandle(process);
        }
    }

    /// <summary>
    /// Reads TokenElevation, distinguishing "not elevated" from "could not tell".
    /// Collapsing the two is what let a failed query stand in for a
    /// non-elevated token.
    /// </summary>
    private static bool TryReadTokenElevation(nint token, out bool elevated)
    {
        elevated = false;
        nint buffer = Marshal.AllocHGlobal(Marshal.SizeOf<NativeMethods.TOKEN_ELEVATION>());
        try
        {
            if (!NativeMethods.GetTokenInformation(
                    token,
                    TokenElevation,
                    buffer,
                    checked((uint)Marshal.SizeOf<NativeMethods.TOKEN_ELEVATION>()),
                    out uint _))
            {
                return false;
            }

            elevated = Marshal.PtrToStructure<NativeMethods.TOKEN_ELEVATION>(buffer).TokenIsElevated != 0;
            return true;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static Outcome<string> ReadTokenUserSid(nint token)
    {
        _ = NativeMethods.GetTokenInformation(token, TokenUser, 0, 0, out uint required);
        if (required == 0 || required > 4_096)
        {
            return Outcome<string>.Refused(RefusalCode.StandardTokenUnavailable);
        }

        nint buffer = Marshal.AllocHGlobal(checked((int)required));
        try
        {
            if (!NativeMethods.GetTokenInformation(token, TokenUser, buffer, required, out uint _))
            {
                return Outcome<string>.Refused(RefusalCode.StandardTokenUnavailable);
            }

            NativeMethods.SID_AND_ATTRIBUTES user =
                Marshal.PtrToStructure<NativeMethods.SID_AND_ATTRIBUTES>(buffer);
            return SidToString(user.Sid);
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static Outcome<string> SidToString(nint sid)
    {
        if (sid == 0 || !NativeMethods.ConvertSidToStringSidW(sid, out nint text) || text == 0)
        {
            return Outcome<string>.Refused(RefusalCode.SecurityDescriptorUnavailable);
        }

        try
        {
            string? value = Marshal.PtrToStringUni(text);
            return value is null
                ? Outcome<string>.Refused(RefusalCode.SecurityDescriptorUnavailable)
                : Outcome<string>.Success(value);
        }
        finally
        {
            _ = NativeMethods.LocalFree(text);
        }
    }

    private static string TrimNul(string value)
    {
        int index = value.IndexOf('\0', StringComparison.Ordinal);
        return index < 0 ? value : value[..index];
    }

    private void Record(string operation, string detail) =>
        log.Add(new CanonicalObject().Set("detail", detail).Set("op", operation));
}

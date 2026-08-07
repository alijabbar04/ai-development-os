using System;
using System.Collections.Generic;
using System.Globalization;

namespace AiDevOs.WindowsProofInstaller;

/// <summary>
/// The exact bit values this component passes to the NT create/open primitive
/// and to the security APIs (ADR 0018 section 2.1).
///
/// They keep their documented SDK spelling on purpose. A reviewer has to be
/// able to read a call site against the Windows documentation without a
/// translation table; renaming <c>FILE_CREATE</c> to <c>FileCreate</c> saves an
/// underscore and costs auditability, which is the wrong trade for a file whose
/// only value is being checkable line by line. CA1707 is suppressed
/// project-wide for exactly this reason and no other.
///
/// This file declares constants only. It contains no <c>DllImport</c>, no
/// <c>Marshal</c>, and no call to anything native, so it is deliberately not on
/// the ADR 0018 section 5 interop allow-list: a number is not an invocation.
/// </summary>
internal static class NtFlags
{
    // ---------------------------------------------------------- ACCESS_MASK
    internal const uint FILE_READ_DATA = 0x00000001;
    internal const uint FILE_LIST_DIRECTORY = 0x00000001;
    internal const uint FILE_WRITE_DATA = 0x00000002;
    internal const uint FILE_ADD_FILE = 0x00000002;
    internal const uint FILE_APPEND_DATA = 0x00000004;
    internal const uint FILE_ADD_SUBDIRECTORY = 0x00000004;
    internal const uint FILE_READ_EA = 0x00000008;
    internal const uint FILE_WRITE_EA = 0x00000010;
    internal const uint FILE_EXECUTE = 0x00000020;
    internal const uint FILE_TRAVERSE = 0x00000020;
    internal const uint FILE_DELETE_CHILD = 0x00000040;
    internal const uint FILE_READ_ATTRIBUTES = 0x00000080;
    internal const uint FILE_WRITE_ATTRIBUTES = 0x00000100;
    internal const uint DELETE = 0x00010000;
    internal const uint READ_CONTROL = 0x00020000;
    internal const uint WRITE_DAC = 0x00040000;
    internal const uint WRITE_OWNER = 0x00080000;
    internal const uint SYNCHRONIZE = 0x00100000;
    internal const uint MAXIMUM_ALLOWED = 0x02000000;
    internal const uint FILE_ALL_ACCESS = 0x001F01FF;
    internal const uint FILE_GENERIC_READ = 0x00120089;
    internal const uint FILE_GENERIC_EXECUTE = 0x001200A0;
    internal const uint FILE_GENERIC_WRITE = 0x00120116;

    /// <summary>
    /// The rights the unelevated proof identity must NOT hold on the installed
    /// closure or on any ancestor this transaction creates (ADR 0018 section
    /// 2.3). <c>FILE_DELETE_CHILD</c> is in the set because holding it on a
    /// parent authorizes deleting a child regardless of the child's own DACL —
    /// finding F5 in the release evidence, confirmed by direct measurement on
    /// the target host.
    /// </summary>
    internal const uint FORBIDDEN_FOR_PROOF_IDENTITY =
        FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_WRITE_EA | FILE_WRITE_ATTRIBUTES |
        FILE_DELETE_CHILD | DELETE | WRITE_DAC | WRITE_OWNER;

    /// <summary>
    /// The rights the proof identity must hold, so the check is satisfiable and
    /// the installed closure is actually usable. A protection check nobody can
    /// satisfy is a check everybody disables.
    /// </summary>
    internal const uint REQUIRED_FOR_PROOF_IDENTITY =
        FILE_READ_DATA | FILE_READ_EA | FILE_EXECUTE | FILE_READ_ATTRIBUTES |
        READ_CONTROL | SYNCHRONIZE;

    // ---------------------------------------------------------- ShareAccess
    internal const uint FILE_SHARE_NONE = 0x00000000;
    internal const uint FILE_SHARE_READ = 0x00000001;
    internal const uint FILE_SHARE_WRITE = 0x00000002;
    internal const uint FILE_SHARE_DELETE = 0x00000004;

    // ----------------------------------------------------- CreateDisposition
    internal const uint FILE_SUPERSEDE = 0;
    internal const uint FILE_OPEN = 1;
    internal const uint FILE_CREATE = 2;
    internal const uint FILE_OPEN_IF = 3;
    internal const uint FILE_OVERWRITE = 4;
    internal const uint FILE_OVERWRITE_IF = 5;

    // --------------------------------------------------------- CreateOptions
    internal const uint FILE_DIRECTORY_FILE = 0x00000001;
    internal const uint FILE_WRITE_THROUGH = 0x00000002;
    internal const uint FILE_SYNCHRONOUS_IO_NONALERT = 0x00000020;
    internal const uint FILE_NON_DIRECTORY_FILE = 0x00000040;
    internal const uint FILE_OPEN_REPARSE_POINT = 0x00200000;

    // ------------------------------------------- OBJECT_ATTRIBUTES.Attributes
    internal const uint OBJ_INHERIT = 0x00000002;
    internal const uint OBJ_CASE_INSENSITIVE = 0x00000040;
    internal const uint OBJ_OPENIF = 0x00000080;
    internal const uint OBJ_OPENLINK = 0x00000100;
    internal const uint OBJ_KERNEL_HANDLE = 0x00000200;
    internal const uint OBJ_FORCE_ACCESS_CHECK = 0x00000400;
    internal const uint OBJ_IGNORE_IMPERSONATED_DEVICEMAP = 0x00000800;
    internal const uint OBJ_DONT_REPARSE = 0x00001000;

    // -------------------------------------------------------- FileAttributes
    internal const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
    internal const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
    internal const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;

    // ------------------------------------------ SECURITY_DESCRIPTOR_CONTROL
    internal const ushort SE_DACL_PRESENT = 0x0004;
    internal const ushort SE_DACL_AUTO_INHERITED = 0x0400;
    internal const ushort SE_DACL_PROTECTED = 0x1000;

    // ------------------------------------------------------------ ACE flags
    internal const byte OBJECT_INHERIT_ACE = 0x01;
    internal const byte CONTAINER_INHERIT_ACE = 0x02;
    internal const byte NO_PROPAGATE_INHERIT_ACE = 0x04;
    internal const byte INHERIT_ONLY_ACE = 0x08;
    internal const byte INHERITED_ACE = 0x10;

    internal const byte ACCESS_ALLOWED_ACE_TYPE = 0x00;
    internal const byte ACCESS_DENIED_ACE_TYPE = 0x01;

    internal static string Hex(uint value) =>
        "0x" + value.ToString("x8", CultureInfo.InvariantCulture);
}

/// <summary>
/// The NTSTATUS values this component distinguishes, and the single mapping
/// from NTSTATUS to a stable refusal class.
///
/// ADR 0018 section 2.2 names correct NTSTATUS-to-refusal mapping as one of the
/// conditions the handle-relative guarantee depends on, and specifically calls
/// out "the statuses that mean something changed underneath you". Those are
/// mapped to their own class rather than being folded into a generic failure,
/// because a transaction that is told the ground moved must refuse rather than
/// retry.
/// </summary>
internal static class NtStatusCodes
{
    internal const uint STATUS_SUCCESS = 0x00000000;
    internal const uint STATUS_REPARSE = 0x00000104;
    internal const uint STATUS_STOPPED_ON_SYMLINK = 0x8000002D;
    internal const uint STATUS_ACCESS_VIOLATION = 0xC0000005;
    internal const uint STATUS_INVALID_HANDLE = 0xC0000008;
    internal const uint STATUS_INVALID_DEVICE_REQUEST = 0xC0000010;
    internal const uint STATUS_ACCESS_DENIED = 0xC0000022;
    internal const uint STATUS_OBJECT_TYPE_MISMATCH = 0xC0000024;
    internal const uint STATUS_OBJECT_NAME_INVALID = 0xC0000033;
    internal const uint STATUS_OBJECT_NAME_NOT_FOUND = 0xC0000034;
    internal const uint STATUS_OBJECT_NAME_COLLISION = 0xC0000035;
    internal const uint STATUS_OBJECT_PATH_NOT_FOUND = 0xC000003A;
    internal const uint STATUS_OBJECT_PATH_SYNTAX_BAD = 0xC000003B;
    internal const uint STATUS_SHARING_VIOLATION = 0xC0000043;
    internal const uint STATUS_DELETE_PENDING = 0xC0000056;
    internal const uint STATUS_PRIVILEGE_NOT_HELD = 0xC0000061;
    internal const uint STATUS_INSUFFICIENT_RESOURCES = 0xC000009A;
    internal const uint STATUS_MEDIA_WRITE_PROTECTED = 0xC00000A2;
    internal const uint STATUS_FILE_IS_A_DIRECTORY = 0xC00000BA;
    internal const uint STATUS_NOT_SUPPORTED = 0xC00000BB;
    internal const uint STATUS_DIRECTORY_NOT_EMPTY = 0xC0000101;
    internal const uint STATUS_NOT_A_DIRECTORY = 0xC0000103;
    internal const uint STATUS_CANNOT_DELETE = 0xC0000121;
    internal const uint STATUS_FILE_DELETED = 0xC0000123;
    internal const uint STATUS_INVALID_PARAMETER = 0xC000000D;
    internal const uint STATUS_IO_REPARSE_TAG_NOT_HANDLED = 0xC0000279;
    internal const uint STATUS_REPARSE_POINT_ENCOUNTERED = 0xC000050B;
    internal const uint STATUS_MOUNT_POINT_NOT_RESOLVED = 0xC0000368;

    internal static bool Succeeded(uint status) => (status & 0x80000000u) == 0;

    /// <summary>
    /// Maps a status to its stable refusal class. Never echoes the numeric
    /// status: the caller learns which class of thing went wrong and nothing
    /// about the filesystem it could not already see.
    /// </summary>
    internal static RefusalCode Classify(uint status) => status switch
    {
        STATUS_SUCCESS => RefusalCode.None,

        // "Something changed underneath you." A name that resolved a moment ago
        // now resolves to an object being deleted, or to nothing. Refuse; do not
        // retry, because retrying is how a loser of a race becomes an adopter of
        // whatever replaced the object.
        STATUS_DELETE_PENDING or STATUS_FILE_DELETED => RefusalCode.NativeChangedUnderneath,

        // A reparse point in the chain. With OBJ_DONT_REPARSE set these are the
        // statuses a planted junction produces, and they must be a refusal
        // rather than a redirection.
        STATUS_REPARSE or STATUS_STOPPED_ON_SYMLINK or STATUS_IO_REPARSE_TAG_NOT_HANDLED
            or STATUS_REPARSE_POINT_ENCOUNTERED or STATUS_MOUNT_POINT_NOT_RESOLVED =>
            RefusalCode.NativeReparsePointEncountered,

        STATUS_OBJECT_NAME_COLLISION => RefusalCode.NativeAlreadyExists,
        STATUS_OBJECT_NAME_NOT_FOUND or STATUS_OBJECT_PATH_NOT_FOUND =>
            RefusalCode.NativeNotFound,
        STATUS_OBJECT_NAME_INVALID or STATUS_OBJECT_PATH_SYNTAX_BAD =>
            RefusalCode.NativeObjectPathInvalid,
        STATUS_ACCESS_DENIED or STATUS_PRIVILEGE_NOT_HELD or STATUS_MEDIA_WRITE_PROTECTED
            or STATUS_CANNOT_DELETE => RefusalCode.NativeAccessDenied,
        STATUS_SHARING_VIOLATION => RefusalCode.NativeSharingViolation,
        STATUS_INVALID_HANDLE or STATUS_OBJECT_TYPE_MISMATCH => RefusalCode.NativeInvalidHandle,
        STATUS_NOT_A_DIRECTORY or STATUS_FILE_IS_A_DIRECTORY => RefusalCode.ComponentNotDirectory,
        STATUS_DIRECTORY_NOT_EMPTY => RefusalCode.RemovalDirectoryNotEmpty,
        STATUS_NOT_SUPPORTED or STATUS_INVALID_DEVICE_REQUEST or STATUS_INVALID_PARAMETER =>
            RefusalCode.NativeNotSupported,
        STATUS_INSUFFICIENT_RESOURCES => RefusalCode.NativeResourceExhausted,
        _ => RefusalCode.NativeUnexpectedFailure,
    };
}

/// <summary>
/// One request to the NT create/open primitive, expressed exactly as the native
/// call will express it. Every field maps one-to-one onto a parameter or an
/// <c>OBJECT_ATTRIBUTES</c> member, so the request object recorded by the
/// simulated filesystem in <c>self-test</c> is the same object the native
/// adapter marshals.
///
/// <see cref="Name"/> is a SINGLE path component. It can never be a path:
/// separators, drive letters, device spellings, and relative segments are
/// rejected by <see cref="NameGrammar"/> before the request is constructed, and
/// the native adapter passes it as the whole <c>ObjectName</c> with
/// <c>RootDirectory</c> set. That is what makes the walk handle-relative rather
/// than string-relative.
/// </summary>
internal sealed class HandleRelativeOpenRequest
{
    internal HandleRelativeOpenRequest(
        string purpose,
        string name,
        uint desiredAccess,
        uint fileAttributes,
        uint shareAccess,
        uint createDisposition,
        uint createOptions,
        uint objectAttributes,
        SecurityDescriptorPlan? securityDescriptor)
    {
        Purpose = purpose;
        Name = name;
        DesiredAccess = desiredAccess;
        FileAttributes = fileAttributes;
        ShareAccess = shareAccess;
        CreateDisposition = createDisposition;
        CreateOptions = createOptions;
        ObjectAttributes = objectAttributes;
        SecurityDescriptor = securityDescriptor;
    }

    /// <summary>A reviewed label for the step, used only in the operation log.</summary>
    internal string Purpose { get; }

    internal string Name { get; }

    internal uint DesiredAccess { get; }

    internal uint FileAttributes { get; }

    internal uint ShareAccess { get; }

    internal uint CreateDisposition { get; }

    internal uint CreateOptions { get; }

    internal uint ObjectAttributes { get; }

    /// <summary>
    /// Supplied at creation, never applied afterwards. ADR 0018 section 2.1
    /// forbids create-then-repair: a directory that exists for even one
    /// scheduling quantum with the creator's default DACL is a window, and a
    /// window is the whole thing this component exists to close.
    /// </summary>
    internal SecurityDescriptorPlan? SecurityDescriptor { get; }

    internal bool IsCreateOnly => CreateDisposition == NtFlags.FILE_CREATE;

    internal bool DeniesDeleteSharing => (ShareAccess & NtFlags.FILE_SHARE_DELETE) == 0;

    internal bool RefusesReparse => (ObjectAttributes & NtFlags.OBJ_DONT_REPARSE) != 0;

    internal bool RequiresDirectory => (CreateOptions & NtFlags.FILE_DIRECTORY_FILE) != 0;

    internal bool InspectsLinkWithoutTraversing =>
        (CreateOptions & NtFlags.FILE_OPEN_REPARSE_POINT) != 0;

    /// <summary>
    /// A canonical, order-independent rendering used by the self-test to pin
    /// the exact flags of every step. If a flag is added, removed, or changed,
    /// the pinned string changes and the vector fails by name.
    /// </summary>
    internal CanonicalObject ToCanonical() =>
        new CanonicalObject()
            .Set("createDisposition", CreateDispositionName(CreateDisposition))
            .Set("createOptions", NtFlags.Hex(CreateOptions))
            .Set("desiredAccess", NtFlags.Hex(DesiredAccess))
            .Set("fileAttributes", NtFlags.Hex(FileAttributes))
            .Set("name", Name)
            .Set("objectAttributes", NtFlags.Hex(ObjectAttributes))
            .Set("purpose", Purpose)
            .Set("securityDescriptor", SecurityDescriptor is null ? "none" : SecurityDescriptor.Sddl)
            .Set("shareAccess", NtFlags.Hex(ShareAccess));

    private static string CreateDispositionName(uint disposition) => disposition switch
    {
        NtFlags.FILE_SUPERSEDE => "FILE_SUPERSEDE",
        NtFlags.FILE_OPEN => "FILE_OPEN",
        NtFlags.FILE_CREATE => "FILE_CREATE",
        NtFlags.FILE_OPEN_IF => "FILE_OPEN_IF",
        NtFlags.FILE_OVERWRITE => "FILE_OVERWRITE",
        NtFlags.FILE_OVERWRITE_IF => "FILE_OVERWRITE_IF",
        _ => "FILE_UNKNOWN_DISPOSITION",
    };
}

/// <summary>
/// An open kernel object plus the ancestry it was reached through.
///
/// The ancestry matters and is not decoration. ADR 0018 section 2.1 requires
/// every ancestor handle to stay open for the whole transaction; an
/// implementation that opened a parent, walked one hop, and released the parent
/// would satisfy "used a handle" while losing the property the handle was for.
/// <see cref="Depth"/> and <see cref="Parent"/> make that observable, and the
/// transaction asserts the whole chain is still open immediately before it
/// creates anything.
/// </summary>
internal sealed class OpenedObject : IDisposable
{
    private readonly IHandleRelativeFileSystem owner;
    private bool closed;

    /// <summary>
    /// The ONLY construction site is
    /// <see cref="HandleRelativeFileSystem.OpenRelative"/> and its volume-root
    /// sibling, both of which live in the shared base class and supply
    /// <paramref name="parent"/> from their own parameter.
    ///
    /// That is deliberate and it is the fix for an audit finding. An earlier
    /// revision let each implementation construct this type, and the native
    /// adapter passed <see langword="null"/> for the parent from a helper whose
    /// two branches both returned null. Every handle in the binary that would
    /// actually run therefore had <c>Parent == null</c>, <c>Depth == 0</c>, and
    /// a <see cref="ChainIsRetained"/> that inspected exactly one handle — the
    /// flagship property of the design, vacuous in the only place it mattered,
    /// while all four retention vectors passed because the simulation supplied
    /// the link the adapter did not. Moving construction into the base makes
    /// the linkage something no implementation can get wrong, because no
    /// implementation is asked.
    /// </summary>
    internal OpenedObject(
        IHandleRelativeFileSystem owner,
        long ordinal,
        string debugComponentName,
        OpenedObject? parent,
        HandleRelativeOpenRequest request)
    {
        this.owner = owner;
        Ordinal = ordinal;
        ComponentName = debugComponentName;
        Parent = parent;
        Request = request;
    }

    /// <summary>
    /// A per-filesystem monotonic identifier. Deliberately NOT the OS handle
    /// value: handle values are recycled and are host state, and a self-test
    /// digest must not depend on either.
    /// </summary>
    internal long Ordinal { get; }

    internal string ComponentName { get; }

    internal OpenedObject? Parent { get; }

    internal HandleRelativeOpenRequest Request { get; }

    internal bool IsOpen => !closed;

    internal int Depth => Parent is null ? 0 : Parent.Depth + 1;

    /// <summary>True only if this handle and every ancestor handle is still open.</summary>
    internal bool ChainIsRetained
    {
        get
        {
            for (OpenedObject? current = this; current is not null; current = current.Parent)
            {
                if (current.closed)
                {
                    return false;
                }
            }

            return true;
        }
    }

    /// <summary>
    /// True only if this handle and every ancestor was opened without delete
    /// sharing, so nothing above the operation can be renamed or deleted while
    /// the transaction runs.
    /// </summary>
    internal bool ChainDeniesDeleteSharing
    {
        get
        {
            for (OpenedObject? current = this; current is not null; current = current.Parent)
            {
                if (!current.Request.DeniesDeleteSharing)
                {
                    return false;
                }
            }

            return true;
        }
    }

    internal void Dispose()
    {
        if (!closed)
        {
            closed = true;
            owner.CloseHandle(this);
        }
    }

    void IDisposable.Dispose() => Dispose();
}

/// <summary>Facts read back through a handle, never by re-resolving a path.</summary>
internal sealed class ObjectFacts
{
    internal ObjectFacts(
        bool isDirectory,
        bool isReparsePoint,
        uint reparseTag,
        uint volumeSerialNumber,
        string fileIdHex,
        string finalPath,
        string fileSystemName,
        long endOfFile)
    {
        IsDirectory = isDirectory;
        IsReparsePoint = isReparsePoint;
        ReparseTag = reparseTag;
        VolumeSerialNumber = volumeSerialNumber;
        FileIdHex = fileIdHex;
        FinalPath = finalPath;
        FileSystemName = fileSystemName;
        EndOfFile = endOfFile;
    }

    internal bool IsDirectory { get; }

    internal bool IsReparsePoint { get; }

    internal uint ReparseTag { get; }

    internal uint VolumeSerialNumber { get; }

    /// <summary>The 128-bit file identifier, lowercase hex, from the handle.</summary>
    internal string FileIdHex { get; }

    internal string FinalPath { get; }

    internal string FileSystemName { get; }

    internal long EndOfFile { get; }

    internal string IdentityKey => string.Create(
        CultureInfo.InvariantCulture,
        $"{VolumeSerialNumber:x8}:{FileIdHex}");
}

/// <summary>One access-control entry, as read back through a handle.</summary>
internal sealed class AceSnapshot
{
    internal AceSnapshot(byte aceType, byte aceFlags, uint accessMask, string sid)
    {
        AceType = aceType;
        AceFlags = aceFlags;
        AccessMask = accessMask;
        Sid = sid;
    }

    internal byte AceType { get; }

    internal byte AceFlags { get; }

    internal uint AccessMask { get; }

    internal string Sid { get; }

    /// <summary>
    /// An inherit-only ACE grants nothing on the object carrying it. Treating
    /// it as if it did is what made an earlier check refuse on stock Windows —
    /// <c>C:\</c> carries an inherit-only Authenticated Users Modify ACE that
    /// confers no access to <c>C:\</c> itself — and a check nobody can satisfy
    /// is a check everybody disables.
    /// </summary>
    internal bool IsInheritOnly => (AceFlags & NtFlags.INHERIT_ONLY_ACE) != 0;

    internal bool IsInherited => (AceFlags & NtFlags.INHERITED_ACE) != 0;

    internal bool IsAllow => AceType == NtFlags.ACCESS_ALLOWED_ACE_TYPE;

    internal bool IsDeny => AceType == NtFlags.ACCESS_DENIED_ACE_TYPE;

    internal CanonicalObject ToCanonical() =>
        new CanonicalObject()
            .Set("accessMask", NtFlags.Hex(AccessMask))
            .Set("aceFlags", NtFlags.Hex(AceFlags))
            .Set("aceType", AceType)
            .Set("sid", Sid);
}

/// <summary>A security descriptor read back through a handle.</summary>
internal sealed class SecuritySnapshot
{
    internal SecuritySnapshot(
        string ownerSid,
        ushort control,
        bool daclPresent,
        IReadOnlyList<AceSnapshot> aces)
    {
        OwnerSid = ownerSid;
        Control = control;
        DaclPresent = daclPresent;
        Aces = aces;
    }

    internal string OwnerSid { get; }

    internal ushort Control { get; }

    internal bool DaclPresent { get; }

    internal IReadOnlyList<AceSnapshot> Aces { get; }

    internal bool DaclIsProtected => (Control & NtFlags.SE_DACL_PROTECTED) != 0;

    /// <summary>
    /// The effective mask an identity holds on THIS object, evaluated the way
    /// the kernel evaluates it: inherit-only ACEs are skipped entirely, deny
    /// ACEs that precede a matching allow remove those bits, and evaluation is
    /// in ACE order.
    ///
    /// This is a second, independent implementation of a decision the kernel
    /// also makes in <c>AccessCheck</c>. Both are used: the kernel's answer is
    /// authoritative for "is the protection real", and this one is used for
    /// "does this existing object match the exact approved DACL", which
    /// <c>AccessCheck</c> cannot answer because it collapses an ACL into a
    /// single mask.
    /// </summary>
    internal uint EffectiveMaskFor(string sid)
    {
        uint granted = 0;
        uint denied = 0;
        foreach (AceSnapshot ace in Aces)
        {
            if (ace.IsInheritOnly || !string.Equals(ace.Sid, sid, StringComparison.Ordinal))
            {
                continue;
            }

            if (ace.IsDeny)
            {
                denied |= ace.AccessMask & ~granted;
            }
            else if (ace.IsAllow)
            {
                granted |= ace.AccessMask & ~denied;
            }
        }

        return granted & ~denied;
    }

    internal CanonicalObject ToCanonical()
    {
        List<CanonicalObject> aces = [];
        foreach (AceSnapshot ace in Aces)
        {
            aces.Add(ace.ToCanonical());
        }

        return new CanonicalObject()
            .Set("aces", aces)
            .Set("control", NtFlags.Hex(Control))
            .Set("daclPresent", DaclPresent)
            .Set("ownerSid", OwnerSid);
    }
}

/// <summary>
/// The kernel's own answer for the proof identity's effective access to an
/// object, obtained by <c>AccessCheck</c> against a standard (filtered,
/// non-elevated) token with <c>MAXIMUM_ALLOWED</c>.
/// </summary>
internal sealed class AccessCheckResult
{
    internal AccessCheckResult(uint grantedAccess, string tokenKind)
    {
        GrantedAccess = grantedAccess;
        TokenKind = tokenKind;
    }

    internal uint GrantedAccess { get; }

    /// <summary>
    /// Which token the check ran against. Recorded because an
    /// <c>AccessCheck</c> against an ELEVATED token would report FullControl
    /// and pass a check that is supposed to fail — a green result from the
    /// wrong token is worse than no result.
    /// </summary>
    internal string TokenKind { get; }

    internal uint ForbiddenGranted => GrantedAccess & NtFlags.FORBIDDEN_FOR_PROOF_IDENTITY;

    internal uint RequiredMissing => NtFlags.REQUIRED_FOR_PROOF_IDENTITY & ~GrantedAccess;
}

/// <summary>A directory listing read through a handle.</summary>
internal sealed class DirectoryListing
{
    internal DirectoryListing(IReadOnlyList<string> fileNames, IReadOnlyList<string> directoryNames)
    {
        FileNames = fileNames;
        DirectoryNames = directoryNames;
    }

    internal IReadOnlyList<string> FileNames { get; }

    internal IReadOnlyList<string> DirectoryNames { get; }

    internal bool IsEmpty => FileNames.Count == 0 && DirectoryNames.Count == 0;

    internal int Count => FileNames.Count + DirectoryNames.Count;
}

/// <summary>Bytes measured through a retained handle, with their digest.</summary>
internal sealed class FileMeasurement
{
    internal FileMeasurement(long size, string sha256Hex, bool measuredThroughHandle)
    {
        Size = size;
        Sha256Hex = sha256Hex;
        MeasuredThroughHandle = measuredThroughHandle;
    }

    internal long Size { get; }

    internal string Sha256Hex { get; }

    /// <summary>
    /// False would mean the digest came from a path-based read rather than from
    /// the retained handle, which is exactly the substitution window this
    /// design exists to close, so the transaction refuses on it.
    /// </summary>
    internal bool MeasuredThroughHandle { get; }
}

/// <summary>The resolved <c>CommonApplicationData</c> known folder.</summary>
internal sealed class KnownFolderResolution
{
    internal KnownFolderResolution(string fullPath, char driveLetter, IReadOnlyList<string> components)
    {
        FullPath = fullPath;
        DriveLetter = driveLetter;
        Components = components;
    }

    internal string FullPath { get; }

    internal char DriveLetter { get; }

    /// <summary>The path components below the volume root, in order.</summary>
    internal IReadOnlyList<string> Components { get; }
}

/// <summary>The unelevated identity the installed closure must be readable by.</summary>
internal sealed class ProofIdentity
{
    internal ProofIdentity(string sid, bool isWellKnownPrivileged)
    {
        Sid = sid;
        IsWellKnownPrivileged = isWellKnownPrivileged;
    }

    internal string Sid { get; }

    /// <summary>
    /// True if the resolved SID is a well-known privileged or universal
    /// principal. Granting the read ACE to <c>Everyone</c>, <c>Users</c>,
    /// <c>Authenticated Users</c>, <c>SYSTEM</c>, or <c>Administrators</c>
    /// would either widen the grant far past the proof identity or make the
    /// subsequent protection check meaningless, so both are refused.
    /// </summary>
    internal bool IsWellKnownPrivileged { get; }
}

/// <summary>
/// The complete set of filesystem and security operations this component may
/// perform, expressed in handle-relative terms.
///
/// There is deliberately NO operation that takes a path. A path cannot be
/// passed to this interface, so a path-check-then-path-use sequence cannot be
/// written against it — the property ADR 0018 section 1 moved the authority to
/// handles for is enforced by the shape of the interface rather than by
/// remembering to be careful.
///
/// Two implementations exist:
///
///   <see cref="SimulatedFileSystem"/> — in-memory, used by <c>self-test</c>.
///       Structurally read-only with respect to the host: it opens no file,
///       creates no object, and touches nothing outside its own dictionaries.
///
///   the native adapter — the real one, which is the only place in this
///       component where interop lives (ADR 0018 section 5).
///
/// Writing the transaction once against this interface is what lets the
/// read-only self-test assert the exact call sequence and the exact flags of a
/// transaction that has never been run.
/// </summary>
internal interface IHandleRelativeFileSystem
{
    /// <summary>
    /// Resolves <c>CommonApplicationData</c> through the known-folder API, not
    /// through the <c>%ProgramData%</c> string (ADR 0018 section 2.1).
    /// </summary>
    Outcome<KnownFolderResolution> ResolveCommonApplicationData();

    /// <summary>
    /// Opens the volume root that carries the known folder, as the one absolute
    /// open of the transaction. Everything below it is handle-relative.
    /// </summary>
    Outcome<OpenedObject> OpenVolumeRoot(char driveLetter, HandleRelativeOpenRequest request);

    /// <summary>Opens or creates one component relative to an already-open parent.</summary>
    Outcome<OpenedObject> OpenRelative(OpenedObject parent, HandleRelativeOpenRequest request);

    /// <summary>
    /// Returns the handle's byte offset to zero.
    ///
    /// This is in the contract because it is a REAL property of the handles this
    /// component opens: they use <c>FILE_SYNCHRONOUS_IO_NONALERT</c>, so the
    /// kernel keeps a per-handle offset and a second read starts where the first
    /// stopped. An audit found the adapter reading a file to EOF and then
    /// "re-measuring" it on the same handle, which hashed zero bytes and
    /// digested the empty string — the design intent, measure what was read,
    /// silently inverted into measuring nothing. Making the rewind explicit puts
    /// the offset in the contract, so the simulation models it too and a missing
    /// rewind is observable without running the adapter.
    /// </summary>
    RefusalCode RewindToStart(OpenedObject handle);

    Outcome<ObjectFacts> QueryFacts(OpenedObject handle);

    Outcome<SecuritySnapshot> QuerySecurity(OpenedObject handle);

    Outcome<AccessCheckResult> AccessCheckAsProofIdentity(OpenedObject handle);

    Outcome<DirectoryListing> ListDirectory(OpenedObject handle);

    /// <summary>
    /// Hashes the file from the handle's current offset to end of file and
    /// cross-checks the number of bytes hashed against the size the SAME handle
    /// reports.
    ///
    /// <see cref="FileMeasurement.MeasuredThroughHandle"/> is that cross-check's
    /// result, not a literal. It used to be a hardcoded <see langword="true"/>
    /// in the adapter, which made the refusal it feeds unreachable in the only
    /// path that matters — and would have hidden the offset defect above, since
    /// hashing zero bytes of a non-empty file is exactly the disagreement this
    /// now detects.
    /// </summary>
    Outcome<FileMeasurement> MeasureFile(OpenedObject handle);

    /// <summary>
    /// Writes the buffer through the handle. The returned measurement describes
    /// the BUFFER, not the file, and reports
    /// <see cref="FileMeasurement.MeasuredThroughHandle"/> as
    /// <see langword="false"/> for that reason: hashing the bytes you just
    /// handed the kernel proves the caller can hash its own array, and nothing
    /// about what landed on disk. Verification is a separate read through a
    /// freshly opened handle.
    /// </summary>
    Outcome<FileMeasurement> WriteThroughHandle(OpenedObject handle, byte[] content);

    Outcome<byte[]> ReadThroughHandle(OpenedObject handle, int maximumBytes);

    RefusalCode FlushBuffers(OpenedObject handle);

    /// <summary>
    /// Marks the object deleted through its own handle. There is no
    /// name-based, wildcard, recursive, or prefix deletion anywhere in this
    /// interface, so none can exist anywhere on the authority path.
    /// </summary>
    RefusalCode DeleteThroughHandle(OpenedObject handle);

    Outcome<ProofIdentity> ResolveProofIdentity();

    void CloseHandle(OpenedObject handle);

    /// <summary>
    /// An append-only, canonical record of every operation performed, in order.
    /// The transaction's proof obligations are stated against this log, so a
    /// step that is skipped, reordered, or performed with different flags is
    /// visible without running the transaction.
    /// </summary>
    IReadOnlyList<CanonicalObject> OperationLog { get; }
}

/// <summary>
/// The shared half of every implementation: ordinal allocation, name-grammar
/// enforcement, parent-handle validation, and — the point of the class —
/// construction of <see cref="OpenedObject"/> with the parent the CALLER named.
///
/// An implementation is asked only to open something and say whether it worked.
/// It is never asked what the parent was, so it cannot answer wrongly. That is
/// a direct response to an audit finding: the previous shape let each
/// implementation build the handle object, and the native adapter supplied
/// <see langword="null"/> for every parent from a helper whose two branches both
/// returned null. The simulation supplied the link correctly, so every
/// contract vector passed while the binary that would actually run had no
/// ancestor chain at all.
///
/// The structural lesson is written into the shape rather than into a comment: a
/// contract vector that only ever runs against the simulation cannot see an
/// adapter that does not implement the contract, so the part of the contract
/// most worth protecting is the part no adapter implements.
/// </summary>
internal abstract class HandleRelativeFileSystem : IHandleRelativeFileSystem
{
    private long nextOrdinal = 1;

    public abstract IReadOnlyList<CanonicalObject> OperationLog { get; }

    public Outcome<OpenedObject> OpenVolumeRoot(char driveLetter, HandleRelativeOpenRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (driveLetter < 'A' || driveLetter > 'Z')
        {
            return Outcome<OpenedObject>.Refused(RefusalCode.KnownFolderPathNotDriveRooted);
        }

        return Materialize(
            parent: null,
            request,
            request.Name,
            ordinal => OpenVolumeRootCore(driveLetter, request, ordinal));
    }

    public Outcome<OpenedObject> OpenRelative(OpenedObject parent, HandleRelativeOpenRequest request)
    {
        ArgumentNullException.ThrowIfNull(parent);
        ArgumentNullException.ThrowIfNull(request);

        // A name that is not a single component would mean a path had been built
        // and handed to a handle-relative primitive. Refusing here, in the
        // shared half, means neither implementation can be the one that forgets.
        if (NameGrammar.Validate(request.Name) != RefusalCode.None)
        {
            return Outcome<OpenedObject>.Refused(RefusalCode.PathUsedWithoutHandle);
        }

        if (!parent.IsOpen)
        {
            return Outcome<OpenedObject>.Refused(RefusalCode.AncestorHandleNotRetained);
        }

        return Materialize(
            parent,
            request,
            request.Name,
            ordinal => OpenRelativeCore(parent, request, ordinal));
    }

    /// <summary>
    /// Allocates the ordinal, asks the implementation to open, and — only on
    /// success — builds the handle object with the parent this method was given.
    /// </summary>
    [System.Diagnostics.CodeAnalysis.SuppressMessage(
        "Reliability",
        "CA2000:Dispose objects before losing scope",
        Justification = "The OpenedObject is the RETURN VALUE: ownership transfers to the caller, which retains it for the whole transaction and disposes it in reverse order. Disposing it here would close the handle this method exists to hand out. The analyzer cannot see ownership transfer through the Outcome wrapper.")]
    private Outcome<OpenedObject> Materialize(
        OpenedObject? parent,
        HandleRelativeOpenRequest request,
        string componentName,
        Func<long, RefusalCode> open)
    {
        long ordinal = nextOrdinal++;
        RefusalCode refusal = open(ordinal);
        if (refusal != RefusalCode.None)
        {
            return Outcome<OpenedObject>.Refused(refusal);
        }

        return Outcome<OpenedObject>.Success(
            new OpenedObject(this, ordinal, componentName, parent, request));
    }

    /// <summary>
    /// Opens the volume root. The implementation registers whatever it needs
    /// against <c>ordinal</c> and returns <see cref="RefusalCode.None"/> on
    /// success. It is not given, and cannot set, the parent.
    /// </summary>
    protected abstract RefusalCode OpenVolumeRootCore(char driveLetter, HandleRelativeOpenRequest request, long ordinal);

    /// <summary>
    /// Opens one component relative to <paramref name="parent"/>. The parent is
    /// passed so the implementation can find its own native handle, and is
    /// deliberately NOT used to build the returned object.
    /// </summary>
    protected abstract RefusalCode OpenRelativeCore(OpenedObject parent, HandleRelativeOpenRequest request, long ordinal);

    public abstract Outcome<KnownFolderResolution> ResolveCommonApplicationData();

    public abstract RefusalCode RewindToStart(OpenedObject handle);

    public abstract Outcome<ObjectFacts> QueryFacts(OpenedObject handle);

    public abstract Outcome<SecuritySnapshot> QuerySecurity(OpenedObject handle);

    public abstract Outcome<AccessCheckResult> AccessCheckAsProofIdentity(OpenedObject handle);

    public abstract Outcome<DirectoryListing> ListDirectory(OpenedObject handle);

    public abstract Outcome<FileMeasurement> MeasureFile(OpenedObject handle);

    public abstract Outcome<FileMeasurement> WriteThroughHandle(OpenedObject handle, byte[] content);

    public abstract Outcome<byte[]> ReadThroughHandle(OpenedObject handle, int maximumBytes);

    public abstract RefusalCode FlushBuffers(OpenedObject handle);

    public abstract RefusalCode DeleteThroughHandle(OpenedObject handle);

    public abstract Outcome<ProofIdentity> ResolveProofIdentity();

    public abstract void CloseHandle(OpenedObject handle);
}

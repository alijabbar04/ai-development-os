using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace AiDevOs.WindowsProofInstaller;

/// <summary>One object in the simulated volume.</summary>
internal sealed class SimulatedNode
{
    internal SimulatedNode(string name, bool isDirectory, long fileId)
    {
        Name = name;
        IsDirectory = isDirectory;
        FileId = fileId;
        Children = new Dictionary<string, SimulatedNode>(StringComparer.OrdinalIgnoreCase);
        Aces = [];
        Content = [];
        OwnerSid = WellKnownSids.BuiltinAdministrators;
    }

    internal string Name { get; set; }

    internal bool IsDirectory { get; }

    internal long FileId { get; set; }

    internal bool IsReparsePoint { get; set; }

    internal uint ReparseTag { get; set; }

    internal string OwnerSid { get; set; }

    internal ushort Control { get; set; }

    internal List<AceSnapshot> Aces { get; set; }

    internal byte[] Content { get; set; }

    internal SimulatedNode? Parent { get; set; }

    internal Dictionary<string, SimulatedNode> Children { get; }

    internal bool Deleted { get; set; }

    internal int OpenHandleCount { get; set; }

    internal int OpenHandlesDenyingDelete { get; set; }
}

/// <summary>
/// The hostile conditions the self-test can inject.
///
/// Each one models something an unelevated attacker can actually do on the
/// target host, established by the direct measurement recorded in release
/// evidence section 24: <c>C:\ProgramData</c> grants
/// <c>BUILTIN\Users:(CI)(WD,AD,WEA,WA)</c> and
/// <c>CREATOR OWNER:(OI)(CI)(IO)(F)</c>, and an unelevated process was observed
/// creating a directory there, becoming its owner with FullControl, and
/// removing it again.
/// </summary>
internal sealed class HostileConditions
{
    /// <summary>Plant a junction at this component name before the walk reaches it.</summary>
    internal string? JunctionAt { get; set; }

    /// <summary>Pre-create this component, owned by the unelevated identity.</summary>
    internal string? UserOwnedDirectoryAt { get; set; }

    /// <summary>Pre-create this component with a correct owner but an extra ACE.</summary>
    internal string? ExtraAceAt { get; set; }

    /// <summary>Pre-create this component with the read ACE marked inherit-only.</summary>
    internal string? InheritOnlyReadAceAt { get; set; }

    /// <summary>Pre-create this component with inheritance left unblocked.</summary>
    internal string? InheritedAceAt { get; set; }

    /// <summary>Create this component just before the transaction's own create.</summary>
    internal string? CollideOnCreateAt { get; set; }

    /// <summary>Replace this component's object identity after it is first opened.</summary>
    internal string? SwapIdentityAfterOpenAt { get; set; }

    /// <summary>Grant the proof identity this extra mask on the named component.</summary>
    internal string? ExtraGrantAt { get; set; }

    internal uint ExtraGrantMask { get; set; }

    /// <summary>Report a non-standard token from AccessCheck.</summary>
    internal string TokenKind { get; set; } = "standard-user";

    /// <summary>Report digests as not measured through the handle.</summary>
    internal bool MeasurementNotThroughHandle { get; set; }

    /// <summary>
    /// Make <c>RewindToStart</c> a successful no-op, so the handle keeps the
    /// offset the previous read left it at.
    ///
    /// This models an adapter that does not reset the file position, which is
    /// the defect an audit found in the real one: the transaction read a source
    /// file to EOF and then measured it on the same handle, hashing zero bytes.
    /// Injecting it here is what makes the transaction's rewind call load-bearing
    /// — delete the call and the happy path breaks, which is the distinguishing
    /// property a guard has to have.
    /// </summary>
    internal bool SkipRewind { get; set; }

    /// <summary>
    /// Fail the enumeration of the named component instead of listing it.
    ///
    /// Models <c>GetFileInformationByHandleEx</c> returning FALSE for a reason
    /// other than end-of-enumeration. The adapter previously treated every
    /// FALSE as the end, so a failed enumeration was indistinguishable from an
    /// empty directory — which silently disabled the source extra-file scan, the
    /// destination extra-entry scan, and removal's proof that a directory is
    /// empty.
    /// </summary>
    internal string? EnumerationFailsAt { get; set; }

    /// <summary>Report a filesystem other than NTFS on the volume root.</summary>
    internal string FileSystemName { get; set; } = ProofConfiguration.RequiredFileSystemName;

    /// <summary>Plant an extra file in the source root.</summary>
    internal string? ExtraSourceFile { get; set; }

    /// <summary>Plant an extra file in the destination leaf after the copy.</summary>
    internal string? ExtraDestinationFileAfterCopy { get; set; }

    /// <summary>Plant a case-duplicate of an existing source file.</summary>
    internal string? CaseDuplicateSourceFile { get; set; }

    /// <summary>Swap one source file's bytes after the closure is measured.</summary>
    internal string? SwapSourceFileAfterMeasure { get; set; }

    /// <summary>Report the proof identity as a well-known privileged principal.</summary>
    internal bool ProofIdentityIsWellKnown { get; set; }

    /// <summary>
    /// Grant the proof identity <c>FILE_DELETE_CHILD</c> on the shared
    /// <c>CommonApplicationData</c> ancestor. This is finding F5 from the
    /// release evidence, reproduced: the created directories can have a perfect
    /// DACL and it does not matter, because delete-child on the parent
    /// authorizes deleting the child regardless of the child's own DACL.
    /// </summary>
    internal bool DeleteChildOnKnownFolder { get; set; }

    /// <summary>Grant the proof identity <c>WRITE_DAC</c> on the shared ancestor.</summary>
    internal bool DaclChangeOnKnownFolder { get; set; }

    /// <summary>Plant unreviewed state in a directory immediately after its create-only open.</summary>
    internal string? PlantFileAfterCreationAt { get; set; }

    /// <summary>Plant unreviewed state after the selected successful directory listing.</summary>
    internal string? PlantFileAfterListingAt { get; set; }

    /// <summary>
    /// Exact directory name whose successful listings count toward the
    /// post-listing mutation occurrence. Keeping this explicit prevents a
    /// source-fixture scan from consuming a removal or rollback mutation.
    /// </summary>
    internal string? PostListingMutationTriggerAt { get; set; }

    /// <summary>
    /// One-based successful listing of the trigger directory after which all
    /// configured post-listing mutations fire. The default is immediately
    /// after the trigger's first successful listing.
    /// </summary>
    internal int PostListingMutationAfterSuccessfulListing { get; set; } = 1;

    /// <summary>Fail deletion of the named exact handle.</summary>
    internal string? DeleteFailsAt { get; set; }

    /// <summary>Change the named object's identity after a directory listing returns.</summary>
    internal string? ChangeIdentityAfterListingAt { get; set; }

    /// <summary>Drift the named object's DACL after a directory listing returns.</summary>
    internal string? ChangeSecurityAfterListingAt { get; set; }

    /// <summary>Grant WRITE_DAC after a listing so DACL drift is independently observable.</summary>
    internal string? ChangeDaclAfterListingAt { get; set; }

    /// <summary>Change the owner after a listing without otherwise changing access.</summary>
    internal string? ChangeOwnerAfterListingAt { get; set; }

    /// <summary>Change the exact DACL using an access-neutral zero-mask ACE.</summary>
    internal string? ChangeExactDaclAfterListingAt { get; set; }

    /// <summary>Turn the named object into a reparse point after a listing returns.</summary>
    internal string? ChangeToReparseAfterListingAt { get; set; }

    /// <summary>Throw from this recorded filesystem operation.</summary>
    internal string? ThrowAtOperation { get; set; }

    /// <summary>One-based occurrence of the selected operation that throws.</summary>
    internal int ThrowAtOperationOccurrence { get; set; } = 1;

    /// <summary>Hostile text that must never cross the transaction boundary.</summary>
    internal string ThrowMessage { get; set; } =
        "SECRET_CANARY C:\\private\\operator-state.json";
}

/// <summary>
/// An in-memory filesystem that implements the same handle-relative contract
/// the native adapter implements.
///
/// It exists so <c>self-test</c> can drive the ENTIRE install and removal
/// transaction, with every flag and every step, while remaining structurally
/// read-only with respect to the host: this file contains no
/// <c>DllImport</c>, no <c>Marshal</c>, no <c>System.IO</c> call, and no
/// syscall of any kind. Everything it manipulates is a dictionary.
///
/// What that does and does not prove is worth stating plainly. It proves the
/// TRANSACTION is correct: the order of operations, the flags on every open,
/// the refusal produced by each hostile condition, and the fact that a defect
/// reintroduced into the transaction changes an observable answer. It proves
/// NOTHING about whether the native adapter marshals those same requests
/// correctly, because a simulation of a syscall is not the syscall. That half
/// is discharged by review of the adapter and, eventually, by running it.
///
/// One consequence is worth naming, because ignoring it hid a defect. Anything
/// the simulation does not model, no vector can see. The per-handle byte offset
/// was previously not modelled, so an adapter that read a file to EOF and then
/// "re-measured" it on the same handle — hashing zero bytes and digesting the
/// empty string — passed every vector. The offset is modelled below for exactly
/// that reason, and <see cref="HostileConditions.SkipRewind"/> injects the
/// missing rewind so the guard's removal is observable.
/// </summary>
internal sealed class SimulatedFileSystem : HandleRelativeFileSystem
{
    internal const string ProofIdentitySid = "S-1-5-21-1111111111-2222222222-3333333333-1001";
    internal const uint VolumeSerial = 0xA1B2C3D4;
    private const char Drive = 'C';

    private readonly HostileConditions hostile;
    private readonly List<CanonicalObject> log = [];
    private readonly Dictionary<long, SimulatedNode> byHandle = [];

    /// <summary>
    /// The byte offset of each open handle, which is per-HANDLE and not per
    /// object: two handles on one file have two offsets. Modelled because the
    /// requests this component issues all carry
    /// <c>FILE_SYNCHRONOUS_IO_NONALERT</c>, so the kernel really does keep one.
    /// </summary>
    private readonly Dictionary<long, long> offsets = [];
    private readonly SimulatedNode volumeRoot;
    private readonly HashSet<string> swappedAlready = new(StringComparer.Ordinal);
    private readonly HashSet<string> postListingChanges = new(StringComparer.Ordinal);
    private readonly Dictionary<string, int> operationOccurrences = new(StringComparer.Ordinal);
    private int successfulListingCount;
    private bool observedPhaseStarted;
    private long nextFileId = 0x1000;

    internal SimulatedFileSystem(HostileConditions? conditions)
    {
        hostile = conditions ?? new HostileConditions();
        volumeRoot = new SimulatedNode("C:\\", isDirectory: true, fileId: 0x5);
        SimulatedNode programData = AddDirectory(volumeRoot, "ProgramData");

        // Stock Windows: BUILTIN\Users hold write-class rights here and
        // CREATOR OWNER holds an inherit-only FullControl. Both are modelled,
        // because a check that only ever ran against a clean parent would not
        // be the check this component needs.
        programData.Aces =
        [
            new AceSnapshot(
                NtFlags.ACCESS_ALLOWED_ACE_TYPE,
                0,
                NtFlags.FILE_ALL_ACCESS,
                WellKnownSids.LocalSystem),
            new AceSnapshot(
                NtFlags.ACCESS_ALLOWED_ACE_TYPE,
                0,
                NtFlags.FILE_ALL_ACCESS,
                WellKnownSids.BuiltinAdministrators),
            new AceSnapshot(
                NtFlags.ACCESS_ALLOWED_ACE_TYPE,
                NtFlags.CONTAINER_INHERIT_ACE,
                NtFlags.FILE_WRITE_DATA | NtFlags.FILE_APPEND_DATA | NtFlags.FILE_WRITE_EA |
                    NtFlags.FILE_WRITE_ATTRIBUTES | NtFlags.FILE_GENERIC_READ |
                    NtFlags.FILE_GENERIC_EXECUTE,
                ProofIdentitySid),
            new AceSnapshot(
                NtFlags.ACCESS_ALLOWED_ACE_TYPE,
                (byte)(NtFlags.OBJECT_INHERIT_ACE | NtFlags.CONTAINER_INHERIT_ACE |
                    NtFlags.INHERIT_ONLY_ACE),
                NtFlags.FILE_ALL_ACCESS,
                WellKnownSids.CreatorOwner),
        ];
        programData.Control = NtFlags.SE_DACL_PRESENT;

        SourceRoot = AddDirectory(AddDirectory(volumeRoot, "staging"), "closure");
        ApplyPrePlanted();
    }

    internal SimulatedNode SourceRoot { get; }

    public override IReadOnlyList<CanonicalObject> OperationLog => log;

    /// <summary>The canonical digest of every operation, in order.</summary>
    internal string OperationLogDigest()
    {
        CanonicalObject envelope = new CanonicalObject()
            .Set("operations", log)
            .Set("schemaVersion", 1);
        return ProofConfiguration.Sha256Hex(CanonicalJson.Serialize(envelope));
    }

    internal string OperationSequence()
    {
        StringBuilder builder = new();
        foreach (CanonicalObject entry in log)
        {
            foreach (KeyValuePair<string, CanonicalValue> member in entry.Members)
            {
                if (string.Equals(member.Key, "op", StringComparison.Ordinal))
                {
                    if (builder.Length > 0)
                    {
                        builder.Append('|');
                    }

                    builder.Append(member.Value.Text);
                }
            }
        }

        return builder.ToString();
    }

    /// <summary>
    /// Exact runtime access requested for the three removal-chain components,
    /// extracted from the operations the transaction actually issued.
    /// </summary>
    internal string RemovalDirectoryAccessSequence()
    {
        List<string> access = [];
        foreach (CanonicalObject entry in log)
        {
            string? operation = null;
            string? purpose = null;
            string? name = null;
            string? desiredAccess = null;
            foreach (KeyValuePair<string, CanonicalValue> member in entry.Members)
            {
                if (string.Equals(member.Key, "op", StringComparison.Ordinal))
                {
                    operation = member.Value.Text;
                }
                else if (string.Equals(member.Key, "purpose", StringComparison.Ordinal))
                {
                    purpose = member.Value.Text;
                }
                else if (string.Equals(member.Key, "name", StringComparison.Ordinal))
                {
                    name = member.Value.Text;
                }
                else if (string.Equals(member.Key, "desiredAccess", StringComparison.Ordinal))
                {
                    desiredAccess = member.Value.Text;
                }
            }

            if (string.Equals(operation, "open-relative", StringComparison.Ordinal) &&
                string.Equals(purpose, "open-removal-component", StringComparison.Ordinal))
            {
                access.Add(string.Concat(name, "=", desiredAccess));
            }
        }

        return string.Join('|', access);
    }

    /// <summary>
    /// Starts one explicitly observed conformance phase. Fixture construction
    /// happens before this call, so it cannot consume a hostile occurrence or
    /// pollute a phase-specific operation trace.
    /// </summary>
    internal void BeginObservedPhase()
    {
        successfulListingCount = 0;
        operationOccurrences.Clear();
        postListingChanges.Clear();
        log.Clear();
        observedPhaseStarted = true;
    }

    /// <summary>Populates the source closure with the named files.</summary>
    internal void PopulateSource(IReadOnlyList<string> names, Func<string, byte[]> content)
    {
        ArgumentNullException.ThrowIfNull(names);
        ArgumentNullException.ThrowIfNull(content);
        foreach (string name in names)
        {
            if (string.Equals(name, ProofConfiguration.InstalledManifestFileName, StringComparison.Ordinal) ||
                string.Equals(name, ProofConfiguration.InstallRecordFileName, StringComparison.Ordinal))
            {
                continue;
            }

            SimulatedNode file = new(name, isDirectory: false, fileId: nextFileId++)
            {
                Parent = SourceRoot,
                Content = content(name),
            };
            SourceRoot.Children[name] = file;
        }

        if (hostile.ExtraSourceFile is string extra)
        {
            SourceRoot.Children[extra] = new SimulatedNode(extra, isDirectory: false, fileId: nextFileId++)
            {
                Parent = SourceRoot,
                Content = [1, 2, 3],
            };
        }

        if (hostile.CaseDuplicateSourceFile is string duplicate)
        {
            // A case-insensitive dictionary cannot hold both spellings, which is
            // exactly the real filesystem's behaviour on NTFS with the default
            // case-insensitive setting. The duplicate is therefore represented
            // as an extra listing entry rather than an extra node.
            extraListingEntries.Add(duplicate);
        }
    }

    private readonly List<string> extraListingEntries = [];

    internal static string SourcePath => string.Create(CultureInfo.InvariantCulture, $"{Drive}:\\staging\\closure");

    // ------------------------------------------------------------- resolution

    public override Outcome<KnownFolderResolution> ResolveCommonApplicationData()
    {
        Record("resolve-known-folder", new CanonicalObject().Set("api", "SHGetKnownFolderPath"));
        return Outcome<KnownFolderResolution>.Success(
            new KnownFolderResolution("C:\\ProgramData", Drive, ["ProgramData"]));
    }

    public override Outcome<ProofIdentity> ResolveProofIdentity()
    {
        Record("resolve-proof-identity", new CanonicalObject().Set("api", "GetTokenInformation for TokenUser"));
        string sid = hostile.ProofIdentityIsWellKnown ? WellKnownSids.BuiltinUsers : ProofIdentitySid;
        return Outcome<ProofIdentity>.Success(
            new ProofIdentity(sid, WellKnownSids.IsWellKnownPrivileged(sid)));
    }

    // ------------------------------------------------------------------ opens

    protected override RefusalCode OpenVolumeRootCore(
        char driveLetter,
        HandleRelativeOpenRequest request,
        long ordinal)
    {
        Record("open-volume-root", request.ToCanonical());
        if (driveLetter != Drive)
        {
            return RefusalCode.VolumeRootUnopenable;
        }

        Register(ordinal, volumeRoot, request);
        return RefusalCode.None;
    }

    /// <summary>
    /// Opens one component and says whether it worked. It is never asked what
    /// the parent handle object was and never builds one: the shared base class
    /// does that from the parent the CALLER named, which is why neither
    /// implementation can be the one that loses the ancestor chain.
    /// </summary>
    protected override RefusalCode OpenRelativeCore(
        OpenedObject parent,
        HandleRelativeOpenRequest request,
        long ordinal)
    {
        Record("open-relative", request.ToCanonical());

        // The base class has already enforced the name grammar and that the
        // parent handle object is open. What is left is this implementation's own
        // question: do WE still have a node registered against it?
        if (!byHandle.TryGetValue(parent.Ordinal, out SimulatedNode? parentNode))
        {
            return RefusalCode.NativeInvalidHandle;
        }

        if (parentNode.Deleted)
        {
            return RefusalCode.NativeChangedUnderneath;
        }

        MaybeCollide(parentNode, request);
        parentNode.Children.TryGetValue(request.Name, out SimulatedNode? node);

        if (request.CreateDisposition == NtFlags.FILE_CREATE)
        {
            if (node is not null)
            {
                return RefusalCode.NativeAlreadyExists;
            }

            if (request.SecurityDescriptor is null)
            {
                // Creating without a descriptor would produce an object with the
                // creator's default DACL, to be repaired afterwards. ADR 0018
                // section 2.1 forbids that: the repair window is the defect.
                return RefusalCode.SecurityDescriptorNotSuppliedAtCreation;
            }

            bool directory = request.RequiresDirectory;
            SimulatedNode created = new(request.Name, directory, nextFileId++)
            {
                Parent = parentNode,
                OwnerSid = request.SecurityDescriptor.OwnerSid,
                Control = (ushort)(NtFlags.SE_DACL_PRESENT | NtFlags.SE_DACL_PROTECTED),
                Aces = new List<AceSnapshot>(request.SecurityDescriptor.ExpectedAces),
            };
            parentNode.Children[request.Name] = created;
            MaybeExtraGrant(created);
            if (string.Equals(
                    hostile.PlantFileAfterCreationAt,
                    request.Name,
                    StringComparison.Ordinal))
            {
                PlantFile(created, "unreviewed-state.bin", [9, 9, 9]);
            }

            Register(ordinal, created, request);
            return RefusalCode.None;
        }

        if (node is null || node.Deleted)
        {
            return RefusalCode.NativeNotFound;
        }

        if (node.IsReparsePoint && !request.InspectsLinkWithoutTraversing)
        {
            // OBJ_DONT_REPARSE: the open fails rather than being redirected.
            return request.RefusesReparse
                ? RefusalCode.NativeReparsePointEncountered
                : RefusalCode.ComponentIsReparsePoint;
        }

        if (request.RequiresDirectory && !node.IsDirectory)
        {
            return RefusalCode.ComponentNotDirectory;
        }

        if ((request.CreateOptions & NtFlags.FILE_NON_DIRECTORY_FILE) != 0 && node.IsDirectory)
        {
            return RefusalCode.ComponentNotDirectory;
        }

        Register(ordinal, node, request);
        return RefusalCode.None;
    }

    // ------------------------------------------------------------- inspection

    public override Outcome<ObjectFacts> QueryFacts(OpenedObject handle)
    {
        ArgumentNullException.ThrowIfNull(handle);
        Record("query-facts", new CanonicalObject()
            .Set("api", "NtQueryInformationFile then GetFileInformationByHandleEx then GetFinalPathNameByHandleW")
            .Set("component", handle.ComponentName));
        if (!handle.IsOpen || !byHandle.TryGetValue(handle.Ordinal, out SimulatedNode? node))
        {
            return Outcome<ObjectFacts>.Refused(RefusalCode.NativeInvalidHandle);
        }

        return Outcome<ObjectFacts>.Success(new ObjectFacts(
            node.IsDirectory,
            node.IsReparsePoint,
            node.ReparseTag,
            VolumeSerial,
            node.FileId.ToString("x16", CultureInfo.InvariantCulture),
            FinalPathOf(node),
            ReferenceEquals(node, volumeRoot) ? hostile.FileSystemName : ProofConfiguration.RequiredFileSystemName,
            node.Content.LongLength));
    }

    public override Outcome<SecuritySnapshot> QuerySecurity(OpenedObject handle)
    {
        ArgumentNullException.ThrowIfNull(handle);
        Record("query-security", new CanonicalObject()
            .Set("api", "GetSecurityInfo on the handle with SE_FILE_OBJECT")
            .Set("component", handle.ComponentName));
        if (!handle.IsOpen || !byHandle.TryGetValue(handle.Ordinal, out SimulatedNode? node))
        {
            return Outcome<SecuritySnapshot>.Refused(RefusalCode.NativeInvalidHandle);
        }

        return Outcome<SecuritySnapshot>.Success(
            new SecuritySnapshot(node.OwnerSid, node.Control, true, node.Aces));
    }

    public override Outcome<AccessCheckResult> AccessCheckAsProofIdentity(OpenedObject handle)
    {
        ArgumentNullException.ThrowIfNull(handle);
        Record("access-check", new CanonicalObject()
            .Set("api", "AccessCheck for MAXIMUM_ALLOWED against the standard token")
            .Set("component", handle.ComponentName));
        if (!handle.IsOpen || !byHandle.TryGetValue(handle.Ordinal, out SimulatedNode? node))
        {
            return Outcome<AccessCheckResult>.Refused(RefusalCode.NativeInvalidHandle);
        }

        SecuritySnapshot snapshot = new(node.OwnerSid, node.Control, true, node.Aces);
        uint granted = snapshot.EffectiveMaskFor(ProofIdentitySid);
        return Outcome<AccessCheckResult>.Success(new AccessCheckResult(granted, hostile.TokenKind));
    }

    public override Outcome<DirectoryListing> ListDirectory(OpenedObject handle)
    {
        ArgumentNullException.ThrowIfNull(handle);
        Record("list-directory", new CanonicalObject()
            .Set("api", "GetFileInformationByHandleEx for FileFullDirectoryInfo")
            .Set("component", handle.ComponentName));
        if (!handle.IsOpen || !byHandle.TryGetValue(handle.Ordinal, out SimulatedNode? node))
        {
            return Outcome<DirectoryListing>.Refused(RefusalCode.NativeInvalidHandle);
        }

        if (!node.IsDirectory)
        {
            return Outcome<DirectoryListing>.Refused(RefusalCode.ComponentNotDirectory);
        }

        if (hostile.EnumerationFailsAt is string failing &&
            string.Equals(failing, node.Name, StringComparison.Ordinal))
        {
            // An enumeration this component cannot complete is a REFUSAL, never
            // an empty answer. Returning success-with-nothing here is what made
            // three separate scans vacuous in the real adapter.
            return Outcome<DirectoryListing>.Refused(RefusalCode.NativeUnexpectedFailure);
        }

        List<string> files = [];
        List<string> directories = [];
        foreach (KeyValuePair<string, SimulatedNode> child in node.Children)
        {
            if (child.Value.Deleted)
            {
                continue;
            }

            if (child.Value.IsDirectory)
            {
                directories.Add(child.Value.Name);
            }
            else
            {
                files.Add(child.Value.Name);
            }
        }

        if (ReferenceEquals(node, SourceRoot))
        {
            files.AddRange(extraListingEntries);
        }

        files.Sort(StringComparer.Ordinal);
        directories.Sort(StringComparer.Ordinal);
        DirectoryListing result = new(files, directories);
        ApplyPostListingChanges(node);
        return Outcome<DirectoryListing>.Success(result);
    }

    public override RefusalCode RewindToStart(OpenedObject handle)
    {
        ArgumentNullException.ThrowIfNull(handle);
        Record("rewind-to-start", new CanonicalObject()
            .Set("api", "SetFilePointerEx to FILE_BEGIN")
            .Set("component", handle.ComponentName));
        if (!handle.IsOpen || !byHandle.ContainsKey(handle.Ordinal))
        {
            return RefusalCode.NativeInvalidHandle;
        }

        if (hostile.SkipRewind)
        {
            // Reports success and moves nothing, which is what an adapter that
            // forgot to seek looks like from the caller's side.
            return RefusalCode.None;
        }

        offsets[handle.Ordinal] = 0;
        return RefusalCode.None;
    }

    public override Outcome<FileMeasurement> MeasureFile(OpenedObject handle)
    {
        ArgumentNullException.ThrowIfNull(handle);
        Record("measure-file", new CanonicalObject()
            .Set("api", "ReadFile on the handle then SHA-256, cross-checked against the reported size")
            .Set("component", handle.ComponentName));
        if (!handle.IsOpen || !byHandle.TryGetValue(handle.Ordinal, out SimulatedNode? node))
        {
            return Outcome<FileMeasurement>.Refused(RefusalCode.NativeInvalidHandle);
        }

        // Hashes from the handle's CURRENT offset, exactly as ReadFile does, and
        // cross-checks the number of bytes hashed against the size the object
        // reports. Measuring the whole node regardless of offset is what let the
        // adapter's zero-byte measurement pass unnoticed.
        byte[] measured = SliceFromOffset(handle.Ordinal, node);
        return Outcome<FileMeasurement>.Success(new FileMeasurement(
            measured.LongLength,
            ProofConfiguration.Sha256Hex(measured),
            measured.LongLength == node.Content.LongLength &&
                !hostile.MeasurementNotThroughHandle));
    }

    public override Outcome<byte[]> ReadThroughHandle(OpenedObject handle, int maximumBytes)
    {
        ArgumentNullException.ThrowIfNull(handle);
        Record("read-through-handle", new CanonicalObject()
            .Set("api", "ReadFile on the handle")
            .Set("component", handle.ComponentName));
        if (!handle.IsOpen || !byHandle.TryGetValue(handle.Ordinal, out SimulatedNode? node))
        {
            return Outcome<byte[]>.Refused(RefusalCode.NativeInvalidHandle);
        }

        if (node.Content.LongLength > maximumBytes)
        {
            return Outcome<byte[]>.Refused(RefusalCode.SourceFileSizeMismatch);
        }

        byte[] copy = SliceFromOffset(handle.Ordinal, node);
        MaybeSwapSourceBytes(node);

        // "The ground moves while the transaction is busy." Source measurement
        // happens after every destination ancestor has been opened and its
        // identity recorded, and before the pre-create re-verification, so a
        // swap injected here is one the transaction can only catch by comparing
        // the identity it recorded with the identity it re-reads. Injecting it
        // any earlier would let both reads see the same value and the vector
        // would pass while proving nothing.
        MaybeSwapIdentity();
        return Outcome<byte[]>.Success(copy);
    }

    public override Outcome<FileMeasurement> WriteThroughHandle(OpenedObject handle, byte[] content)
    {
        ArgumentNullException.ThrowIfNull(handle);
        ArgumentNullException.ThrowIfNull(content);
        Record("write-through-handle", new CanonicalObject()
            .Set("api", "WriteFile on the handle")
            .Set("component", handle.ComponentName));
        if (!handle.IsOpen || !byHandle.TryGetValue(handle.Ordinal, out SimulatedNode? node))
        {
            return Outcome<FileMeasurement>.Refused(RefusalCode.NativeInvalidHandle);
        }

        node.Content = (byte[])content.Clone();

        // WriteFile advances the offset. Modelling that is the point: it is why
        // a measurement taken on the write handle afterwards has to rewind
        // first, and why one that does not measures nothing.
        offsets[handle.Ordinal] = content.LongLength;
        if (string.Equals(
                node.Name,
                ProofConfiguration.InstalledManifestFileName,
                StringComparison.Ordinal) &&
            node.Parent is not null)
        {
            // The manifest is written last, so this is the moment after the
            // copy and before the re-measurement — exactly where an attacker
            // who can write into the leaf would drop a file.
            PlantExtraDestinationEntry(node.Parent);
        }

        // Describes the BUFFER, not the file, and says so — the same answer the
        // native adapter gives, for the same reason: hashing the array you just
        // handed the kernel proves nothing about what landed on disk.
        return Outcome<FileMeasurement>.Success(new FileMeasurement(
            content.LongLength,
            ProofConfiguration.Sha256Hex(content),
            measuredThroughHandle: false));
    }

    /// <summary>
    /// The bytes from this handle's offset to the end of the object, advancing
    /// the offset by what was returned — the behaviour of a synchronous
    /// <c>ReadFile</c>.
    /// </summary>
    private byte[] SliceFromOffset(long ordinal, SimulatedNode node)
    {
        long offset = offsets.TryGetValue(ordinal, out long value) ? value : 0;
        if (offset >= node.Content.LongLength)
        {
            return [];
        }

        byte[] slice = new byte[node.Content.LongLength - offset];
        Array.Copy(node.Content, offset, slice, 0, slice.LongLength);
        offsets[ordinal] = node.Content.LongLength;
        return slice;
    }

    public override RefusalCode FlushBuffers(OpenedObject handle)
    {
        ArgumentNullException.ThrowIfNull(handle);
        Record("flush-buffers", new CanonicalObject()
            .Set("api", "FlushFileBuffers on the handle")
            .Set("component", handle.ComponentName));
        return handle.IsOpen ? RefusalCode.None : RefusalCode.NativeInvalidHandle;
    }

    public override RefusalCode DeleteThroughHandle(OpenedObject handle)
    {
        ArgumentNullException.ThrowIfNull(handle);
        Record("delete-through-handle", new CanonicalObject()
            .Set("api", "NtSetInformationFile for FileDispositionInformationEx")
            .Set("component", handle.ComponentName));
        if (!handle.IsOpen || !byHandle.TryGetValue(handle.Ordinal, out SimulatedNode? node))
        {
            return RefusalCode.NativeInvalidHandle;
        }

        if (string.Equals(hostile.DeleteFailsAt, node.Name, StringComparison.Ordinal))
        {
            return RefusalCode.DeleteFailed;
        }

        if ((handle.Request.DesiredAccess & NtFlags.DELETE) == 0)
        {
            return RefusalCode.NativeAccessDenied;
        }

        if (node.IsDirectory)
        {
            foreach (KeyValuePair<string, SimulatedNode> child in node.Children)
            {
                if (!child.Value.Deleted)
                {
                    return RefusalCode.RemovalDirectoryNotEmpty;
                }
            }
        }

        node.Deleted = true;
        node.Parent?.Children.Remove(node.Name);
        return RefusalCode.None;
    }

    private void ApplyPostListingChanges(SimulatedNode listedNode)
    {
        if (!observedPhaseStarted ||
            hostile.PostListingMutationTriggerAt is not string trigger ||
            !string.Equals(listedNode.Name, trigger, StringComparison.Ordinal))
        {
            return;
        }

        successfulListingCount++;
        if (successfulListingCount != hostile.PostListingMutationAfterSuccessfulListing)
        {
            return;
        }

        ApplyPostListingChange(
            hostile.PlantFileAfterListingAt,
            "child",
            node =>
            {
                if (node.IsDirectory)
                {
                    PlantFile(node, "post-listing-state.bin", [7, 7, 7]);
                }
            });
        ApplyPostListingChange(hostile.ChangeIdentityAfterListingAt, "identity", node => node.FileId++);
        ApplyPostListingChange(
            hostile.ChangeSecurityAfterListingAt,
            "security",
            node => node.Aces.Add(new AceSnapshot(
                NtFlags.ACCESS_ALLOWED_ACE_TYPE,
                0,
                NtFlags.FILE_WRITE_DATA,
                ProofIdentitySid)));
        ApplyPostListingChange(
            hostile.ChangeDaclAfterListingAt,
            "dacl",
            node => node.Aces.Add(new AceSnapshot(
                NtFlags.ACCESS_ALLOWED_ACE_TYPE,
                0,
                NtFlags.WRITE_DAC,
                ProofIdentitySid)));
        ApplyPostListingChange(
            hostile.ChangeOwnerAfterListingAt,
            "owner",
            node => node.OwnerSid = WellKnownSids.LocalSystem);
        ApplyPostListingChange(
            hostile.ChangeExactDaclAfterListingAt,
            "exact-dacl",
            node => node.Aces.Add(new AceSnapshot(
                NtFlags.ACCESS_ALLOWED_ACE_TYPE,
                0,
                0,
                WellKnownSids.BuiltinUsers)));
        ApplyPostListingChange(
            hostile.ChangeToReparseAfterListingAt,
            "reparse",
            node =>
            {
                node.IsReparsePoint = true;
                node.ReparseTag = 0xA0000003;
            });
    }

    private void ApplyPostListingChange(
        string? component,
        string kind,
        Action<SimulatedNode> change)
    {
        if (component is null ||
            !postListingChanges.Add(string.Concat(kind, ":", component)))
        {
            return;
        }

        SimulatedNode? node = FindByName(volumeRoot, component);
        if (node is not null)
        {
            change(node);
        }
    }

    public override void CloseHandle(OpenedObject handle)
    {
        ArgumentNullException.ThrowIfNull(handle);
        _ = offsets.Remove(handle.Ordinal);
        if (byHandle.Remove(handle.Ordinal, out SimulatedNode? node))
        {
            node.OpenHandleCount--;
            if (handle.Request.DeniesDeleteSharing)
            {
                node.OpenHandlesDenyingDelete--;
            }
        }
    }

    // ------------------------------------------------------ hostile injection

    /// <summary>
    /// Attempts the rename an attacker would attempt. Returns false when a
    /// retained handle denies delete sharing, which is the kernel's own
    /// behaviour and the property the whole design rests on.
    /// </summary>
    internal bool TryHostileRename(string componentName, string newName)
    {
        SimulatedNode? node = FindByName(volumeRoot, componentName);
        if (node?.Parent is null)
        {
            return false;
        }

        if (node.OpenHandlesDenyingDelete > 0)
        {
            return false;
        }

        node.Parent.Children.Remove(node.Name);
        node.Name = newName;
        node.Parent.Children[newName] = node;
        return true;
    }

    internal bool AnyHandleOpen => byHandle.Count > 0;

    internal int OpenHandleCount => byHandle.Count;

    internal SimulatedNode? Find(params string[] components)
    {
        ArgumentNullException.ThrowIfNull(components);
        SimulatedNode current = volumeRoot;
        foreach (string component in components)
        {
            if (!current.Children.TryGetValue(component, out SimulatedNode? next) || next.Deleted)
            {
                return null;
            }

            current = next;
        }

        return current;
    }

    /// <summary>Plants an extra file in the leaf, used by the removal vectors.</summary>
    internal void PlantFile(SimulatedNode directory, string name, byte[] content)
    {
        ArgumentNullException.ThrowIfNull(directory);
        ArgumentNullException.ThrowIfNull(content);
        directory.Children[name] = new SimulatedNode(name, isDirectory: false, nextFileId++)
        {
            Parent = directory,
            Content = content,
        };
    }

    /// <summary>
    /// The parent a pre-planted component belongs under.
    ///
    /// Getting this wrong makes a hostile vector test nothing: an earlier
    /// revision planted every hostile component directly under
    /// <c>ProgramData</c>, so the junction meant for the SECOND chain position
    /// sat beside the real chain instead of inside it, the transaction never
    /// touched it, and the install SUCCEEDED while the vector claimed to be
    /// proving that a junction is refused. It was caught only because the
    /// vector's expected value was pinned to the refusal rather than to
    /// "something went wrong". A vector that plants its trap in the wrong place
    /// is the same failure mode as a guard whose removal changes nothing.
    /// </summary>
    private SimulatedNode HostileParentOf(string component)
    {
        SimulatedNode programData = volumeRoot.Children["ProgramData"];
        if (string.Equals(component, ProofConfiguration.InstallRootFirstComponent, StringComparison.Ordinal))
        {
            return programData;
        }

        SimulatedNode first = ProtectedDirectory(programData, ProofConfiguration.InstallRootFirstComponent);
        if (string.Equals(component, ProofConfiguration.InstallRootSecondComponent, StringComparison.Ordinal))
        {
            return first;
        }

        return ProtectedDirectory(first, ProofConfiguration.InstallRootSecondComponent);
    }

    private void ApplyPrePlanted()
    {
        if (hostile.JunctionAt is string junction)
        {
            SimulatedNode node = AddDirectory(HostileParentOf(junction), junction);
            node.IsReparsePoint = true;
            node.ReparseTag = 0xA0000003;
        }

        if (hostile.DeleteChildOnKnownFolder || hostile.DaclChangeOnKnownFolder)
        {
            // The F5 scenario, modelled where it actually lives: the proof
            // identity holds a delete-class right on a SHARED ancestor this
            // transaction does not own and must not modify. The created
            // directories below it can have a perfect DACL and it does not
            // help, because FILE_DELETE_CHILD on the parent authorizes deleting
            // the child regardless of the child's own DACL.
            SimulatedNode programData = volumeRoot.Children["ProgramData"];
            uint extra = hostile.DeleteChildOnKnownFolder ? NtFlags.FILE_DELETE_CHILD : 0;
            extra |= hostile.DaclChangeOnKnownFolder ? NtFlags.WRITE_DAC : 0;
            programData.Aces.Add(new AceSnapshot(
                NtFlags.ACCESS_ALLOWED_ACE_TYPE,
                0,
                extra,
                ProofIdentitySid));
        }

        if (hostile.UserOwnedDirectoryAt is string userOwned)
        {
            SimulatedNode node = AddDirectory(HostileParentOf(userOwned), userOwned);
            node.OwnerSid = ProofIdentitySid;
            node.Control = (ushort)(NtFlags.SE_DACL_PRESENT | NtFlags.SE_DACL_PROTECTED);
            node.Aces =
            [
                new AceSnapshot(
                    NtFlags.ACCESS_ALLOWED_ACE_TYPE,
                    (byte)(NtFlags.OBJECT_INHERIT_ACE | NtFlags.CONTAINER_INHERIT_ACE),
                    NtFlags.FILE_ALL_ACCESS,
                    ProofIdentitySid),
            ];
        }

        if (hostile.ExtraAceAt is string extraAce)
        {
            SimulatedNode node = ProtectedDirectory(HostileParentOf(extraAce), extraAce);
            node.Aces.Add(new AceSnapshot(
                NtFlags.ACCESS_ALLOWED_ACE_TYPE,
                (byte)(NtFlags.OBJECT_INHERIT_ACE | NtFlags.CONTAINER_INHERIT_ACE),
                NtFlags.FILE_ALL_ACCESS,
                WellKnownSids.BuiltinUsers));
        }

        if (hostile.InheritOnlyReadAceAt is string inheritOnly)
        {
            SimulatedNode node = ProtectedDirectory(HostileParentOf(inheritOnly), inheritOnly);
            node.Aces[2] = new AceSnapshot(
                NtFlags.ACCESS_ALLOWED_ACE_TYPE,
                (byte)(NtFlags.OBJECT_INHERIT_ACE | NtFlags.CONTAINER_INHERIT_ACE |
                    NtFlags.INHERIT_ONLY_ACE),
                NtFlags.FILE_GENERIC_READ | NtFlags.FILE_GENERIC_EXECUTE,
                ProofIdentitySid);
        }

        if (hostile.InheritedAceAt is string inherited)
        {
            SimulatedNode node = ProtectedDirectory(HostileParentOf(inherited), inherited);
            node.Control = NtFlags.SE_DACL_PRESENT;
            node.Aces.Add(new AceSnapshot(
                NtFlags.ACCESS_ALLOWED_ACE_TYPE,
                NtFlags.INHERITED_ACE,
                NtFlags.FILE_ALL_ACCESS,
                WellKnownSids.CreatorOwner));
        }
    }

    private SimulatedNode ProtectedDirectory(SimulatedNode parent, string name)
    {
        SimulatedNode node = AddDirectory(parent, name);
        node.OwnerSid = WellKnownSids.BuiltinAdministrators;
        node.Control = (ushort)(NtFlags.SE_DACL_PRESENT | NtFlags.SE_DACL_PROTECTED);
        const byte inheritFlags = NtFlags.OBJECT_INHERIT_ACE | NtFlags.CONTAINER_INHERIT_ACE;
        node.Aces =
        [
            new AceSnapshot(
                NtFlags.ACCESS_ALLOWED_ACE_TYPE, inheritFlags, NtFlags.FILE_ALL_ACCESS,
                WellKnownSids.LocalSystem),
            new AceSnapshot(
                NtFlags.ACCESS_ALLOWED_ACE_TYPE, inheritFlags, NtFlags.FILE_ALL_ACCESS,
                WellKnownSids.BuiltinAdministrators),
            new AceSnapshot(
                NtFlags.ACCESS_ALLOWED_ACE_TYPE,
                inheritFlags,
                NtFlags.FILE_GENERIC_READ | NtFlags.FILE_GENERIC_EXECUTE,
                ProofIdentitySid),
        ];
        return node;
    }

    private void MaybeCollide(SimulatedNode parent, HandleRelativeOpenRequest request)
    {
        if (hostile.CollideOnCreateAt is not string target ||
            !string.Equals(target, request.Name, StringComparison.Ordinal) ||
            request.CreateDisposition != NtFlags.FILE_CREATE ||
            !swappedAlready.Add("collide:" + target))
        {
            return;
        }

        // The attacker wins the race by a hair. Create-only disposition turns
        // that into a collision, which is a refusal, rather than into an
        // adoption of whatever the attacker just created.
        AddDirectory(parent, target);
    }

    private void MaybeSwapIdentity()
    {
        if (hostile.SwapIdentityAfterOpenAt is not string target ||
            !swappedAlready.Add("swap:" + target))
        {
            return;
        }

        // The component is replaced between the check and the next use. With
        // the handle retained and delete sharing denied this cannot happen on a
        // real filesystem, which is why the vector that injects it has to reach
        // in and do it directly rather than going through the interface.
        SimulatedNode? node = FindByName(volumeRoot, target);
        if (node is not null)
        {
            node.FileId = nextFileId++;
        }
    }

    private void MaybeSwapSourceBytes(SimulatedNode node)
    {
        if (hostile.SwapSourceFileAfterMeasure is not string target ||
            !string.Equals(target, node.Name, StringComparison.Ordinal) ||
            !swappedAlready.Add("bytes:" + target))
        {
            return;
        }

        node.Content = [0xDE, 0xAD, 0xBE, 0xEF];
    }

    private void MaybeExtraGrant(SimulatedNode node)
    {
        if (hostile.ExtraGrantAt is not string target ||
            !string.Equals(target, node.Name, StringComparison.Ordinal))
        {
            return;
        }

        node.Aces.Add(new AceSnapshot(
            NtFlags.ACCESS_ALLOWED_ACE_TYPE,
            0,
            hostile.ExtraGrantMask,
            ProofIdentitySid));
    }

    internal void PlantExtraDestinationEntry(SimulatedNode leaf)
    {
        if (hostile.ExtraDestinationFileAfterCopy is string extra)
        {
            PlantFile(leaf, extra, [9, 9, 9]);
        }
    }

    // ---------------------------------------------------------------- helpers

    private SimulatedNode AddDirectory(SimulatedNode parent, string name)
    {
        if (parent.Children.TryGetValue(name, out SimulatedNode? existing))
        {
            return existing;
        }

        SimulatedNode node = new(name, isDirectory: true, nextFileId++) { Parent = parent };
        parent.Children[name] = node;
        return node;
    }

    private static SimulatedNode? FindByName(SimulatedNode root, string name)
    {
        foreach (KeyValuePair<string, SimulatedNode> child in root.Children)
        {
            if (string.Equals(child.Value.Name, name, StringComparison.Ordinal))
            {
                return child.Value;
            }

            SimulatedNode? found = FindByName(child.Value, name);
            if (found is not null)
            {
                return found;
            }
        }

        return null;
    }

    private static string FinalPathOf(SimulatedNode node)
    {
        List<string> parts = [];
        for (SimulatedNode? current = node; current?.Parent is not null; current = current.Parent)
        {
            parts.Add(current.Name);
        }

        parts.Reverse();
        StringBuilder builder = new("C:\\");
        for (int index = 0; index < parts.Count; index++)
        {
            if (index > 0)
            {
                builder.Append('\\');
            }

            builder.Append(parts[index]);
        }

        return builder.ToString();
    }

    /// <summary>
    /// Records the node this implementation opened against the ordinal the BASE
    /// class allocated, and starts its offset at zero.
    ///
    /// It deliberately does not build an <see cref="OpenedObject"/>. The handle
    /// object and its parent link belong to the shared base class, so this
    /// implementation is never asked what the parent was and cannot answer
    /// wrongly — which is the whole content of the fix.
    /// </summary>
    private void Register(long ordinal, SimulatedNode node, HandleRelativeOpenRequest request)
    {
        byHandle[ordinal] = node;
        offsets[ordinal] = 0;
        node.OpenHandleCount++;
        if (request.DeniesDeleteSharing)
        {
            node.OpenHandlesDenyingDelete++;
        }
    }

    private void Record(string operation, CanonicalObject detail)
    {
        int occurrence = operationOccurrences.TryGetValue(operation, out int current)
            ? current + 1
            : 1;
        operationOccurrences[operation] = occurrence;
        if (observedPhaseStarted &&
            string.Equals(hostile.ThrowAtOperation, operation, StringComparison.Ordinal) &&
            hostile.ThrowAtOperationOccurrence == occurrence)
        {
            throw new InvalidOperationException(hostile.ThrowMessage);
        }

        log.Add(detail.Set("op", operation));
    }
}

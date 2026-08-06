using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace AiDevOs.WindowsHelper;

/// <summary>
/// How a closure member's bytes were obtained.
///
/// This exists because "we hashed the right bytes" and "we hashed the bytes
/// that will actually load" are different claims. Only
/// <see cref="ThroughHeldHandle"/> supports the second one: it means the digest
/// was computed by reading the very kernel handle that stays open across
/// process creation, so nothing can substitute the content in between.
/// <see cref="ByPath"/> is the defect this type exists to name — a digest taken
/// by re-opening a path is evidence about a path, not about a file.
/// </summary>
internal enum ClosureMeasurementProvenance
{
    Unknown = 0,
    ThroughHeldHandle = 1,
    ByPath = 2,
}

/// <summary>
/// The sharing posture actually requested when a closure handle was opened.
///
/// ADR 0017 section 6.5 step 3 requires sharing that permits read but denies
/// write <em>and</em> delete. Denying write alone is not enough: on Windows a
/// file opened with <c>FILE_SHARE_DELETE</c> can be renamed out of the way and
/// replaced while the handle is held, which reopens exactly the substitution
/// window the held handle is supposed to close.
/// </summary>
internal sealed class ClosureSharePosture
{
    private ClosureSharePosture(bool permitsRead, bool permitsWrite, bool permitsDelete)
    {
        PermitsRead = permitsRead;
        PermitsWrite = permitsWrite;
        PermitsDelete = permitsDelete;
    }

    internal bool PermitsRead { get; }

    internal bool PermitsWrite { get; }

    internal bool PermitsDelete { get; }

    /// <summary>The only acceptable posture: read shared, write and delete denied.</summary>
    internal static ClosureSharePosture DenyWriteAndDelete { get; } = new(true, false, false);

    internal static ClosureSharePosture FromFileShare(FileShare share) =>
        new(
            (share & FileShare.Read) == FileShare.Read,
            (share & FileShare.Write) == FileShare.Write,
            (share & FileShare.Delete) == FileShare.Delete);

    internal RefusalCode Issue()
    {
        if (PermitsWrite)
        {
            return RefusalCode.ClosureShareModePermitsWrite;
        }

        return PermitsDelete ? RefusalCode.ClosureShareModePermitsDelete : RefusalCode.None;
    }

    internal CanonicalObject ToCanonical() =>
        new CanonicalObject()
            .Set("permitsDelete", PermitsDelete)
            .Set("permitsRead", PermitsRead)
            .Set("permitsWrite", PermitsWrite);
}

/// <summary>
/// One retained, load-bearing handle to a single closure member.
///
/// The contract that matters is lifetime: the handle is opened before the file
/// is measured, the measurement reads <em>through it</em>, and it stays open
/// until the owning <see cref="VerifiedClosureLease"/> is disposed — which
/// happens only after the creation/identity boundary has completed or the whole
/// operation has failed closed.
///
/// <see cref="TryMeasure"/> is deliberately non-virtual. Subclasses supply only
/// the byte-reading step; the invariants (still open, correct share posture,
/// correct provenance) are checked here, once, so a new subclass cannot forget
/// them or quietly weaken them.
/// </summary>
internal abstract class ClosureHandle : IDisposable
{
    private bool disposed;

    protected ClosureHandle(string name, ClosureSharePosture sharePosture, ClosureMeasurementProvenance provenance)
    {
        Name = name;
        SharePosture = sharePosture;
        Provenance = provenance;
    }

    internal string Name { get; }

    internal ClosureSharePosture SharePosture { get; }

    internal ClosureMeasurementProvenance Provenance { get; }

    /// <summary>True until the owning lease disposes this handle.</summary>
    internal bool IsOpen => !disposed && IsUnderlyingHandleOpen;

    protected abstract bool IsUnderlyingHandleOpen { get; }

    /// <summary>
    /// The single measurement entry point. Every invariant is asserted before a
    /// byte is read, so a caller cannot measure a handle it has already closed
    /// and cannot accept a measurement that did not come through the handle.
    /// </summary>
    internal bool TryMeasure(out long size, out string sha256Hex, out RefusalCode code)
    {
        size = 0;
        sha256Hex = string.Empty;

        code = AssertUsable();
        if (code != RefusalCode.None)
        {
            return false;
        }

        return TryMeasureCore(out size, out sha256Hex, out code);
    }

    /// <summary>
    /// The invariant set, exposed separately so the creation boundary can
    /// re-assert it immediately before <c>CreateProcessW</c> without re-hashing
    /// tens of megabytes.
    /// </summary>
    internal RefusalCode AssertUsable()
    {
        if (!IsOpen)
        {
            return RefusalCode.ClosureHandleClosed;
        }

        RefusalCode shareIssue = SharePosture.Issue();
        if (shareIssue != RefusalCode.None)
        {
            return shareIssue;
        }

        return Provenance == ClosureMeasurementProvenance.ThroughHeldHandle
            ? RefusalCode.None
            : RefusalCode.ClosureMeasurementNotThroughHandle;
    }

    protected abstract bool TryMeasureCore(out long size, out string sha256Hex, out RefusalCode code);

    protected virtual void Dispose(bool disposing) => disposed = true;

    public void Dispose()
    {
        Dispose(true);
        GC.SuppressFinalize(this);
    }

    /// <summary>
    /// Hashes a fixed byte range incrementally. Shared by every subclass so the
    /// in-memory and Win32 paths cannot compute different digests for the same
    /// bytes.
    /// </summary>
    protected static string Sha256HexOf(ReadOnlySpan<byte> content) => ArtifactManifest.Sha256Hex(content);

    protected static string ToHex(ReadOnlySpan<byte> digest)
    {
        StringBuilder builder = new(digest.Length * 2);
        foreach (byte value in digest)
        {
            builder.Append(value.ToString("x2", CultureInfo.InvariantCulture));
        }

        return builder.ToString();
    }
}

/// <summary>
/// An in-memory closure member. Used only by the read-only self-test, so the
/// lease and boundary logic can be driven end to end without opening a file,
/// creating a process, or touching the host.
/// </summary>
internal sealed class InMemoryClosureHandle : ClosureHandle
{
    private readonly byte[] content;
    private bool closed;

    internal InMemoryClosureHandle(
        string name,
        byte[] content,
        ClosureSharePosture sharePosture,
        ClosureMeasurementProvenance provenance)
        : base(name, sharePosture, provenance) => this.content = content;

    internal InMemoryClosureHandle(string name, byte[] content)
        : this(name, content, ClosureSharePosture.DenyWriteAndDelete, ClosureMeasurementProvenance.ThroughHeldHandle)
    {
    }

    protected override bool IsUnderlyingHandleOpen => !closed;

    protected override bool TryMeasureCore(out long size, out string sha256Hex, out RefusalCode code)
    {
        size = content.LongLength;
        sha256Hex = Sha256HexOf(content);
        code = RefusalCode.None;
        return true;
    }

    protected override void Dispose(bool disposing)
    {
        closed = true;
        base.Dispose(disposing);
    }
}

/// <summary>
/// A real closure member held open with a Windows file handle.
///
/// The handle is opened with <see cref="FileShare.Read"/>, which sets only
/// <c>FILE_SHARE_READ</c> and therefore denies both write and delete for as
/// long as it is held. Measurement uses <see cref="RandomAccess"/> against the
/// same <see cref="SafeFileHandle"/>: no <see cref="FileStream"/> is
/// constructed over it, so nothing can take ownership of the handle and close
/// it early as a side effect of disposing a reader.
/// </summary>
internal sealed class Win32FileClosureHandle : ClosureHandle
{
    private const FileShare RequiredShare = FileShare.Read;
    private const int MeasurementBufferBytes = 65_536;

    private readonly SafeFileHandle handle;

    /// <summary>
    /// The sharing posture this class will actually request, exposed so the
    /// read-only self-test can assert it without opening a file. Widening
    /// <see cref="RequiredShare"/> is otherwise invisible to an in-memory suite.
    /// </summary>
    internal static ClosureSharePosture RequiredPosture => ClosureSharePosture.FromFileShare(RequiredShare);

    private Win32FileClosureHandle(string name, SafeFileHandle handle)
        : base(name, ClosureSharePosture.FromFileShare(RequiredShare), ClosureMeasurementProvenance.ThroughHeldHandle) =>
        this.handle = handle;

    protected override bool IsUnderlyingHandleOpen => !handle.IsClosed && !handle.IsInvalid;

    /// <summary>
    /// Opens and retains one closure member. The caller owns the returned
    /// handle and must dispose it through the lease.
    /// </summary>
    internal static bool TryOpen(
        string absolutePath,
        string name,
        out Win32FileClosureHandle opened,
        out RefusalCode code)
    {
        opened = null!;
        SafeFileHandle? candidate = null;
        try
        {
            candidate = File.OpenHandle(
                absolutePath,
                FileMode.Open,
                FileAccess.Read,
                RequiredShare,
                FileOptions.SequentialScan);
            opened = new Win32FileClosureHandle(name, candidate);
            candidate = null;
            code = RefusalCode.None;
            return true;
        }
        catch (FileNotFoundException)
        {
            code = RefusalCode.ManifestFileMissing;
            return false;
        }
        catch (DirectoryNotFoundException)
        {
            code = RefusalCode.ManifestFileMissing;
            return false;
        }
        catch (UnauthorizedAccessException)
        {
            code = RefusalCode.NativeAccessDenied;
            return false;
        }
        catch (IOException)
        {
            // A sharing violation lands here and is a refusal, not a retry: if
            // the file cannot be opened deny-write right now, something else
            // holds it writable and the bytes are not pinned.
            code = RefusalCode.ClosureHandleUnavailable;
            return false;
        }
        finally
        {
            candidate?.Dispose();
        }
    }

    protected override bool TryMeasureCore(out long size, out string sha256Hex, out RefusalCode code)
    {
        size = 0;
        sha256Hex = string.Empty;
        try
        {
            long length = RandomAccess.GetLength(handle);
            byte[] buffer = new byte[MeasurementBufferBytes];
            using IncrementalHash hasher = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            long offset = 0;
            while (offset < length)
            {
                int read = RandomAccess.Read(handle, buffer, offset);
                if (read <= 0)
                {
                    // The file shrank under a handle that denies write. Treat
                    // it as unreadable rather than hashing a short prefix.
                    code = RefusalCode.ClosureHandleUnavailable;
                    return false;
                }

                hasher.AppendData(buffer, 0, read);
                offset += read;
            }

            size = length;
            sha256Hex = ToHex(hasher.GetHashAndReset());
            code = RefusalCode.None;
            return true;
        }
        catch (IOException)
        {
            code = RefusalCode.ClosureHandleUnavailable;
            return false;
        }
        catch (UnauthorizedAccessException)
        {
            code = RefusalCode.NativeAccessDenied;
            return false;
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            handle.Dispose();
        }

        base.Dispose(disposing);
    }
}

/// <summary>Where a closure's retained handles come from.</summary>
internal interface IVerifiedClosureSource
{
    IReadOnlyList<string> EnumerateFileNames();

    bool TryOpenRetained(string name, out ClosureHandle handle, out RefusalCode code);
}

/// <summary>In-memory source used only by the read-only self-test.</summary>
internal sealed class InMemoryClosureSource : IVerifiedClosureSource
{
    private readonly SortedDictionary<string, byte[]> files = new(StringComparer.Ordinal);
    private readonly ClosureSharePosture sharePosture;
    private readonly ClosureMeasurementProvenance provenance;

    internal InMemoryClosureSource()
        : this(ClosureSharePosture.DenyWriteAndDelete, ClosureMeasurementProvenance.ThroughHeldHandle)
    {
    }

    internal InMemoryClosureSource(ClosureSharePosture sharePosture, ClosureMeasurementProvenance provenance)
    {
        this.sharePosture = sharePosture;
        this.provenance = provenance;
    }

    internal InMemoryClosureSource Add(string name, byte[] content)
    {
        files[name] = content;
        return this;
    }

    public IReadOnlyList<string> EnumerateFileNames() => new List<string>(files.Keys);

    public bool TryOpenRetained(string name, out ClosureHandle handle, out RefusalCode code)
    {
        handle = null!;
        if (!files.TryGetValue(name, out byte[]? content))
        {
            code = RefusalCode.ManifestFileMissing;
            return false;
        }

        handle = new InMemoryClosureHandle(name, content, sharePosture, provenance);
        code = RefusalCode.None;
        return true;
    }
}

/// <summary>
/// A real installed bundle directory, resolved and validated before any handle
/// is opened.
/// </summary>
internal sealed class InstalledBundleClosureSource : IVerifiedClosureSource
{
    private readonly ResolvedBundleRoot root;

    internal InstalledBundleClosureSource(ResolvedBundleRoot root) => this.root = root;

    public IReadOnlyList<string> EnumerateFileNames() => root.EnumeratedFileNames;

    public bool TryOpenRetained(string name, out ClosureHandle handle, out RefusalCode code)
    {
        handle = null!;
        if (!root.TryResolveMemberPath(name, out string absolutePath, out code))
        {
            return false;
        }

        if (!Win32FileClosureHandle.TryOpen(absolutePath, name, out Win32FileClosureHandle opened, out code))
        {
            return false;
        }

        handle = opened;
        return true;
    }
}

/// <summary>
/// A disposable verified-closure lease.
///
/// This type is the whole point of ADR 0017 section 6.5 steps 3 and 4. It owns
/// every load-bearing handle of one component's closure, keeps them open across
/// <c>CreateProcessW</c>, and is disposed only after the creation and identity
/// cross-check have completed or the operation has failed closed. Disposing it
/// earlier is the defect it replaced: the previous <c>IArtifactFileSource</c>
/// opened a handle, hashed, and closed it before returning, which proved only
/// that the bytes were right at some past instant.
/// </summary>
internal sealed class VerifiedClosureLease : IDisposable
{
    private readonly List<ClosureHandle> handles;
    private bool disposed;

    private VerifiedClosureLease(ArtifactManifest manifest, List<ClosureHandle> handles)
    {
        Manifest = manifest;
        this.handles = handles;
    }

    internal ArtifactManifest Manifest { get; }

    internal int HandleCount => handles.Count;

    internal bool IsOpen => !disposed;

    /// <summary>
    /// The full invariant check. Called when the lease is acquired, and again
    /// immediately before every process creation that depends on it.
    /// </summary>
    internal RefusalCode AssertUsable()
    {
        if (disposed)
        {
            return RefusalCode.ClosureLeaseNotHeld;
        }

        if (handles.Count == 0 || handles.Count != Manifest.Files.Count)
        {
            return RefusalCode.ClosureLeaseIncomplete;
        }

        foreach (ClosureHandle handle in handles)
        {
            RefusalCode issue = handle.AssertUsable();
            if (issue != RefusalCode.None)
            {
                return issue;
            }
        }

        return RefusalCode.None;
    }

    internal bool TryFindHandle(string name, out ClosureHandle handle)
    {
        foreach (ClosureHandle candidate in handles)
        {
            if (string.Equals(candidate.Name, name, StringComparison.Ordinal))
            {
                handle = candidate;
                return true;
            }
        }

        handle = null!;
        return false;
    }

    internal CanonicalObject ToCanonical() =>
        new CanonicalObject()
            .Set("component", Manifest.Component)
            .Set("handleCount", HandleCount)
            .Set("open", IsOpen)
            .Set("usable", ProtocolNames.Of(AssertUsable()));

    /// <summary>
    /// Acquires a lease over the closure of a resolved installed bundle.
    ///
    /// This is the production entry point: the caller supplies a bundle root
    /// that has already been proved absolute, reparse-free, inside the approved
    /// installation root, and unambiguous, and gets back either a held lease or
    /// a refusal.
    /// </summary>
    internal static ClosureLeaseResult AcquireFromInstalledBundle(
        ArtifactManifest manifest,
        ResolvedBundleRoot root) =>
        Acquire(manifest, new InstalledBundleClosureSource(root));

    /// <summary>
    /// Acquires a lease and returns it inside a disposable scope holder.
    ///
    /// The holder exists so that every call site is a <c>using</c> statement.
    /// A lease that is not scoped is a lease somebody has to remember to
    /// release, and "remember to release the thing that pins the bytes" is the
    /// failure mode this whole type exists to remove.
    /// </summary>

    /// <summary>
    /// Acquires a lease over an entire manifest closure.
    ///
    /// Order is load-bearing and matches ADR 0017 section 6.5: enumerate and
    /// reject missing, extra, duplicate, and case-only-duplicate entries first;
    /// then open every member with deny-write, deny-delete sharing; then hash
    /// through those exact handles and compare size and digest. On any failure
    /// every handle opened so far is disposed, so a partial closure never
    /// escapes as a usable lease.
    ///
    /// On success ownership of every handle transfers to the returned
    /// <see cref="ClosureLeaseResult"/>, and it is released only when that
    /// result is disposed.
    /// </summary>
    internal static ClosureLeaseResult Acquire(ArtifactManifest manifest, IVerifiedClosureSource source)
    {
        List<ClosureHandle> opened = [];
        VerifiedClosureLease? candidate = null;
        try
        {
            RefusalCode code = VerifyEnumeration(manifest, source);
            if (code != RefusalCode.None)
            {
                return ClosureLeaseResult.Refused(code);
            }

            foreach (ArtifactFileEntry entry in manifest.Files)
            {
                if (!source.TryOpenRetained(entry.Name, out ClosureHandle handle, out code))
                {
                    return ClosureLeaseResult.Refused(code);
                }

                opened.Add(handle);

                if (!handle.TryMeasure(out long size, out string digest, out code))
                {
                    return ClosureLeaseResult.Refused(code);
                }

                if (size != entry.Size)
                {
                    return ClosureLeaseResult.Refused(RefusalCode.ManifestFileSizeMismatch);
                }

                if (!string.Equals(digest, entry.Sha256, StringComparison.Ordinal))
                {
                    return ClosureLeaseResult.Refused(RefusalCode.ManifestFileDigestMismatch);
                }
            }

            candidate = new VerifiedClosureLease(manifest, opened);
            code = candidate.AssertUsable();
            if (code != RefusalCode.None)
            {
                return ClosureLeaseResult.Refused(code);
            }

            ClosureLeaseResult held = ClosureLeaseResult.Held(candidate);

            // Ownership has transferred to the result. Clearing both locals
            // stops the finally block below from closing handles the caller is
            // now relying on staying open across process creation.
            candidate = null;
            opened = [];
            return held;
        }
        finally
        {
            candidate?.Dispose();
            foreach (ClosureHandle handle in opened)
            {
                handle.Dispose();
            }
        }
    }

    private static RefusalCode VerifyEnumeration(ArtifactManifest manifest, IVerifiedClosureSource source)
    {
        HashSet<string> expected = new(StringComparer.Ordinal);
        HashSet<string> expectedCaseInsensitive = new(StringComparer.OrdinalIgnoreCase);
        foreach (ArtifactFileEntry entry in manifest.Files)
        {
            if (!expected.Add(entry.Name) || !expectedCaseInsensitive.Add(entry.Name))
            {
                return RefusalCode.ManifestFileDuplicate;
            }
        }

        HashSet<string> seen = new(StringComparer.Ordinal);
        HashSet<string> seenCaseInsensitive = new(StringComparer.OrdinalIgnoreCase);
        int presentCount = 0;
        foreach (string name in source.EnumerateFileNames())
        {
            presentCount++;
            if (!seen.Add(name) || !seenCaseInsensitive.Add(name))
            {
                return RefusalCode.ManifestFileDuplicate;
            }

            if (!expected.Contains(name))
            {
                return RefusalCode.ManifestFileUnexpected;
            }
        }

        return presentCount == manifest.Files.Count ? RefusalCode.None : RefusalCode.ManifestFileMissing;
    }

    public void Dispose()
    {
        if (disposed)
        {
            return;
        }

        disposed = true;
        foreach (ClosureHandle handle in handles)
        {
            handle.Dispose();
        }
    }
}

/// <summary>
/// A scoped acquisition outcome: either a held lease or a refusal code, in a
/// shape that makes the lease's lifetime a <c>using</c> block at every call
/// site.
/// </summary>
internal sealed class ClosureLeaseResult : IDisposable
{
    private ClosureLeaseResult(VerifiedClosureLease? lease, RefusalCode code)
    {
        Lease = lease;
        Code = code;
    }

    internal VerifiedClosureLease? Lease { get; }

    internal RefusalCode Code { get; }

    internal bool IsHeld => Lease is not null;

    internal static ClosureLeaseResult Held(VerifiedClosureLease lease) => new(lease, RefusalCode.None);

    internal static ClosureLeaseResult Refused(RefusalCode code) => new(null, code);

    public void Dispose() => Lease?.Dispose();
}

/// <summary>
/// A reference to one closure member that has been verified <em>and</em> is
/// still pinned by a live lease.
///
/// Native process creation accepts only this type, never a string. That is what
/// makes "an unverified path reached <c>CreateProcessW</c>" structurally
/// impossible rather than merely discouraged: there is no overload that takes a
/// path, so a caller cannot supply one.
/// </summary>
internal sealed class VerifiedImageReference
{
    internal VerifiedImageReference(VerifiedClosureLease lease, string fileName, string absolutePath)
    {
        Lease = lease;
        FileName = fileName;
        AbsolutePath = absolutePath;
    }

    internal VerifiedClosureLease Lease { get; }

    internal string FileName { get; }

    /// <summary>
    /// The absolute path resolved once, during verification, from the already
    /// validated bundle root. It is never recomputed from caller input and is
    /// used only as <c>lpApplicationName</c>.
    /// </summary>
    internal string AbsolutePath { get; }

    /// <summary>
    /// Re-asserts the whole lease immediately before use. Callers must invoke
    /// this at the last possible moment, not once at setup time.
    /// </summary>
    internal RefusalCode AssertUsableNow() => Lease.AssertUsable();
}

/// <summary>What a child reported about itself over the protocol.</summary>
internal sealed class ReportedComponentIdentity
{
    internal ReportedComponentIdentity(
        string component,
        string sourceVersion,
        int protocolVersion,
        int buildRecipeVersion,
        string manifestFingerprint)
    {
        Component = component;
        SourceVersion = sourceVersion;
        ProtocolVersion = protocolVersion;
        BuildRecipeVersion = buildRecipeVersion;
        ManifestFingerprint = manifestFingerprint;
    }

    internal string Component { get; }

    internal string SourceVersion { get; }

    internal int ProtocolVersion { get; }

    internal int BuildRecipeVersion { get; }

    internal string ManifestFingerprint { get; }
}

/// <summary>
/// The gate every process creation must pass, and the identity cross-check
/// every created child must pass afterwards (ADR 0017 section 6.5 steps 4
/// and 5).
/// </summary>
internal static class ProcessCreationBoundary
{
    /// <summary>
    /// Authorizes one image for creation. Refuses unless the lease is still
    /// held, every handle in it is still open with deny-write and deny-delete
    /// sharing, every measurement came through a held handle, and the requested
    /// image is a member of the verified closure.
    /// </summary>
    internal static bool TryAuthorize(
        VerifiedClosureLease lease,
        ResolvedBundleRoot root,
        string imageFileName,
        out VerifiedImageReference image,
        out RefusalCode code)
    {
        image = null!;

        code = lease.AssertUsable();
        if (code != RefusalCode.None)
        {
            return false;
        }

        if (!lease.TryFindHandle(imageFileName, out _))
        {
            code = RefusalCode.ClosureImageNotVerified;
            return false;
        }

        if (!root.TryResolveMemberPath(imageFileName, out string absolutePath, out code))
        {
            return false;
        }

        image = new VerifiedImageReference(lease, imageFileName, absolutePath);
        code = RefusalCode.None;
        return true;
    }

    /// <summary>
    /// The check performed at the last instruction before <c>CreateProcessW</c>.
    /// Separated so it can be driven by the read-only self-test without
    /// creating anything.
    /// </summary>
    internal static RefusalCode AssertCreationPermitted(VerifiedImageReference image) =>
        image.AssertUsableNow();

    /// <summary>
    /// Cross-checks what the child said it is against the manifest that was
    /// verified. A child whose reported identity differs from the verified
    /// closure is a substitution, and it fails after creation rather than being
    /// tolerated.
    /// </summary>
    internal static RefusalCode CrossCheckChildIdentity(
        ArtifactManifest manifest,
        ReportedComponentIdentity reported,
        string expectedManifestFingerprint)
    {
        if (!string.Equals(reported.Component, manifest.Component, StringComparison.Ordinal) ||
            !string.Equals(reported.SourceVersion, manifest.SourceVersion, StringComparison.Ordinal) ||
            reported.ProtocolVersion != manifest.ProtocolVersion ||
            reported.BuildRecipeVersion != manifest.BuildRecipeVersion)
        {
            return RefusalCode.ChildIdentityMismatch;
        }

        return string.Equals(reported.ManifestFingerprint, expectedManifestFingerprint, StringComparison.Ordinal)
            ? RefusalCode.None
            : RefusalCode.ChildIdentityMismatch;
    }
}

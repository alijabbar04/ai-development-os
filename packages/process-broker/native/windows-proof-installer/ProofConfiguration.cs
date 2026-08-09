using System;
using System.Collections.Generic;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace AiDevOs.WindowsProofInstaller;

/// <summary>
/// The closed filename and component-name grammar (ADR 0018 section 2.4).
///
/// Everything this component ever names — a directory component, a source file,
/// a destination file, a manifest — must pass this grammar first. The grammar
/// is an allow-list of one ASCII shape, not a denylist of bad shapes, because a
/// denylist of Windows path spellings is a game nobody has ever won: alternate
/// data streams, device names, trailing dots and spaces, short-name aliases,
/// UNC and device prefixes, and Unicode confusables are all second spellings of
/// a name, and the only reliable defence against a second spelling is to accept
/// exactly one.
/// </summary>
internal static class NameGrammar
{
    internal const int MaximumNameLength = 128;

    /// <summary>
    /// Reserved DOS device stems. A file called <c>NUL.json</c> is still the
    /// NUL device on Windows, so the stem before the first dot is what is
    /// compared, case-insensitively.
    /// </summary>
    private static readonly HashSet<string> ReservedStems = new(StringComparer.OrdinalIgnoreCase)
        {
            "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$",
            "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
            "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
        };

    /// <summary>
    /// A single path component in the one accepted spelling, or a refusal.
    /// Never a path: a separator of any kind is a refusal, so a value that
    /// passes this can only ever name one object inside one directory.
    /// </summary>
    internal static RefusalCode Validate(string? name)
    {
        if (string.IsNullOrEmpty(name) || name.Length > MaximumNameLength)
        {
            return RefusalCode.ComponentNameInvalid;
        }

        for (int index = 0; index < name.Length; index++)
        {
            char character = name[index];
            bool allowed =
                (character >= 'A' && character <= 'Z') ||
                (character >= 'a' && character <= 'z') ||
                (character >= '0' && character <= '9') ||
                character == '.' || character == '-' || character == '_';
            if (!allowed)
            {
                // Catches every separator, ':' (alternate data streams and
                // drive letters), '\\' and '/' (path and UNC spellings), '?'
                // and '*' (wildcards), '<' '>' '|' '"' (redirection and quoting),
                // control characters, spaces, and every non-ASCII character.
                return RefusalCode.ComponentNameInvalid;
            }
        }

        char first = name[0];
        bool firstIsAlphanumeric =
            (first >= 'A' && first <= 'Z') ||
            (first >= 'a' && first <= 'z') ||
            (first >= '0' && first <= '9');
        if (!firstIsAlphanumeric)
        {
            return RefusalCode.ComponentNameInvalid;
        }

        // Trailing dot or space: Windows silently strips these on some paths,
        // making "name." and "name" two spellings of one object.
        char last = name[^1];
        if (last == '.' || last == ' ')
        {
            return RefusalCode.ComponentNameInvalid;
        }

        if (name.Contains("..", StringComparison.Ordinal))
        {
            return RefusalCode.ComponentNameInvalid;
        }

        // Short-name alias: "PROGRA~1" is a second spelling of a long name.
        if (name.Contains('~', StringComparison.Ordinal))
        {
            return RefusalCode.ComponentNameInvalid;
        }

        int dot = name.IndexOf('.', StringComparison.Ordinal);
        string stem = dot < 0 ? name : name[..dot];
        return ReservedStems.Contains(stem)
            ? RefusalCode.ComponentNameInvalid
            : RefusalCode.None;
    }

    /// <summary>
    /// A 32-character lowercase-hex run token. Uppercase is refused rather than
    /// folded: two spellings of one token would derive two spellings of one
    /// directory name, which is the same defect as a case-duplicate filename.
    /// </summary>
    internal static bool IsRunToken(string? token)
    {
        if (token is null || token.Length != 32)
        {
            return false;
        }

        foreach (char character in token)
        {
            bool hex = (character >= '0' && character <= '9') ||
                       (character >= 'a' && character <= 'f');
            if (!hex)
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// A reviewed candidate identifier. Deliberately NOT hex-shaped and
    /// deliberately length-bounded below 64, so a 64-character digest can never
    /// be mistaken for a candidate id by the argument parser. ADR 0018 section
    /// 2.4: a fingerprint supplied on the command line is not a trust root.
    /// </summary>
    internal static bool IsCandidateId(string? id)
    {
        if (id is null || id.Length < 3 || id.Length > 48)
        {
            return false;
        }

        foreach (char character in id)
        {
            bool allowed = (character >= 'a' && character <= 'z') ||
                           (character >= '0' && character <= '9') ||
                           character == '-';
            if (!allowed)
            {
                return false;
            }
        }

        return id[0] != '-' && id[^1] != '-';
    }

    internal static bool IsSha256Hex(string? value)
    {
        if (value is null || value.Length != 64)
        {
            return false;
        }

        foreach (char character in value)
        {
            bool hex = (character >= '0' && character <= '9') ||
                       (character >= 'a' && character <= 'f');
            if (!hex)
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// Splits a caller-supplied absolute path into a drive letter and a list of
    /// components, each of which must pass <see cref="Validate"/>.
    ///
    /// This is the ONLY place a path string is accepted anywhere in this
    /// component, and accepting it grants no trust whatsoever: the result is
    /// immediately consumed by the same handle-relative walk the destination
    /// uses, so a caller can say where to look and can say nothing at all about
    /// what is acceptable once the walk gets there.
    ///
    /// Exactly one spelling is accepted: <c>X:\a\b\c</c> with an ASCII drive
    /// letter. Every second spelling of the same location is refused —
    /// <c>\\?\</c>, <c>\\.\</c>, UNC, forward slashes, a bare drive-relative
    /// path, a trailing separator, an empty component, and anything containing
    /// a character the component grammar rejects. F11 in the release evidence
    /// was exactly this defect in the PowerShell package: a normalizer whose
    /// purpose was rejecting second spellings accepted three of them.
    /// </summary>
    internal static RefusalCode TryParseDriveRootedPath(
        string? path,
        out char driveLetter,
        out IReadOnlyList<string> components)
    {
        driveLetter = '\0';
        components = [];

        if (path is null || path.Length < 3 || path.Length > 1024)
        {
            return RefusalCode.ArgumentInvalid;
        }

        char drive = path[0];
        bool upper = drive >= 'A' && drive <= 'Z';
        bool lower = drive >= 'a' && drive <= 'z';
        if ((!upper && !lower) || path[1] != ':' || path[2] != '\\')
        {
            return RefusalCode.ArgumentInvalid;
        }

        if (path.Contains('/', StringComparison.Ordinal))
        {
            return RefusalCode.ArgumentInvalid;
        }

        string remainder = path[3..];
        if (remainder.Length == 0 || remainder.EndsWith('\\'))
        {
            return RefusalCode.ArgumentInvalid;
        }

        string[] parts = remainder.Split('\\');
        List<string> parsed = new(parts.Length);
        foreach (string part in parts)
        {
            RefusalCode refusal = Validate(part);
            if (refusal != RefusalCode.None)
            {
                return refusal;
            }

            parsed.Add(part);
        }

        driveLetter = upper ? drive : char.ToUpperInvariant(drive);
        components = parsed;
        return RefusalCode.None;
    }
}

/// <summary>Well-known SIDs this component names, in their canonical strings.</summary>
internal static class WellKnownSids
{
    internal const string LocalSystem = "S-1-5-18";
    internal const string BuiltinAdministrators = "S-1-5-32-544";
    internal const string BuiltinUsers = "S-1-5-32-545";
    internal const string Everyone = "S-1-1-0";
    internal const string AuthenticatedUsers = "S-1-5-11";
    internal const string CreatorOwner = "S-1-3-0";
    internal const string Anonymous = "S-1-5-7";
    internal const string InteractiveUsers = "S-1-5-4";

    /// <summary>
    /// Principals that must never be used as the proof identity: granting the
    /// read ACE to any of them either widens the grant to every local account
    /// or aims the subsequent protection check at a principal that already has
    /// FullControl, which would make the check pass for the wrong reason.
    /// </summary>
    internal static bool IsWellKnownPrivileged(string sid) =>
        string.Equals(sid, LocalSystem, StringComparison.Ordinal) ||
        string.Equals(sid, BuiltinAdministrators, StringComparison.Ordinal) ||
        string.Equals(sid, BuiltinUsers, StringComparison.Ordinal) ||
        string.Equals(sid, Everyone, StringComparison.Ordinal) ||
        string.Equals(sid, AuthenticatedUsers, StringComparison.Ordinal) ||
        string.Equals(sid, CreatorOwner, StringComparison.Ordinal) ||
        string.Equals(sid, Anonymous, StringComparison.Ordinal) ||
        string.Equals(sid, InteractiveUsers, StringComparison.Ordinal) ||
        !sid.StartsWith("S-1-5-21-", StringComparison.Ordinal);
}

/// <summary>
/// The exact security descriptor supplied at creation, and the exact ACE set an
/// existing component must already have.
///
/// The descriptor is composed once, as SDDL, from compiled-in constants plus
/// the resolved proof identity SID. It is passed in
/// <c>OBJECT_ATTRIBUTES.SecurityDescriptor</c> so the object is never visible
/// with any other descriptor — not for one scheduling quantum. ADR 0018 section
/// 2.1 forbids create-then-repair because the repair window is itself the
/// vulnerability.
/// </summary>
internal sealed class SecurityDescriptorPlan
{
    private SecurityDescriptorPlan(
        string sddl,
        string ownerSid,
        IReadOnlyList<AceSnapshot> expectedAces,
        bool inheritable)
    {
        Sddl = sddl;
        OwnerSid = ownerSid;
        ExpectedAces = expectedAces;
        Inheritable = inheritable;
    }

    internal string Sddl { get; }

    internal string OwnerSid { get; }

    /// <summary>
    /// The exact ACEs, in order, that the created object must carry and that an
    /// existing component must already carry to be accepted. Order is part of
    /// the comparison because ACE order is semantically load-bearing.
    /// </summary>
    internal IReadOnlyList<AceSnapshot> ExpectedAces { get; }

    internal bool Inheritable { get; }

    /// <summary>
    /// Composes the protected descriptor for a directory.
    ///
    /// <c>D:P</c> is the load-bearing token: it protects the DACL so nothing is
    /// inherited from the parent. That matters here more than usual, because
    /// the parent is <c>C:\ProgramData</c>, which on stock Windows grants
    /// <c>BUILTIN\Users:(CI)(WD,AD,WEA,WA)</c> and
    /// <c>CREATOR OWNER:(OI)(CI)(IO)(F)</c>. Inheriting either would hand the
    /// unelevated identity exactly the rights the protection check then has to
    /// prove it does not have.
    /// </summary>
    internal static Outcome<SecurityDescriptorPlan> ForDirectory(ProofIdentity identity)
    {
        if (identity.IsWellKnownPrivileged)
        {
            return Outcome<SecurityDescriptorPlan>.Refused(RefusalCode.ProofIdentityUnacceptable);
        }

        if (!IsAcceptableSidSpelling(identity.Sid))
        {
            return Outcome<SecurityDescriptorPlan>.Refused(RefusalCode.ProofIdentityUnacceptable);
        }

        const byte inheritFlags = NtFlags.OBJECT_INHERIT_ACE | NtFlags.CONTAINER_INHERIT_ACE;
        string sddl = string.Concat(
            "O:", ShortForm(WellKnownSids.BuiltinAdministrators),
            "G:", ShortForm(WellKnownSids.BuiltinAdministrators),
            "D:P",
            "(A;OICI;FA;;;", ShortForm(WellKnownSids.LocalSystem), ")",
            "(A;OICI;FA;;;", ShortForm(WellKnownSids.BuiltinAdministrators), ")",
            "(A;OICI;0x1200a9;;;", identity.Sid, ")");

        List<AceSnapshot> aces =
        [
            new AceSnapshot(
                NtFlags.ACCESS_ALLOWED_ACE_TYPE,
                inheritFlags,
                NtFlags.FILE_ALL_ACCESS,
                WellKnownSids.LocalSystem),
            new AceSnapshot(
                NtFlags.ACCESS_ALLOWED_ACE_TYPE,
                inheritFlags,
                NtFlags.FILE_ALL_ACCESS,
                WellKnownSids.BuiltinAdministrators),
            new AceSnapshot(
                NtFlags.ACCESS_ALLOWED_ACE_TYPE,
                inheritFlags,
                NtFlags.FILE_GENERIC_READ | NtFlags.FILE_GENERIC_EXECUTE,
                identity.Sid),
        ];

        return Outcome<SecurityDescriptorPlan>.Success(new SecurityDescriptorPlan(
            sddl,
            WellKnownSids.BuiltinAdministrators,
            aces,
            inheritable: true));
    }

    /// <summary>
    /// The same descriptor without inheritance flags, for an installed file.
    /// A leaf file has no children, so an inheritable ACE on it would be noise
    /// that a later exact-DACL comparison would have to tolerate.
    /// </summary>
    internal static Outcome<SecurityDescriptorPlan> ForFile(ProofIdentity identity)
    {
        Outcome<SecurityDescriptorPlan> directory = ForDirectory(identity);
        if (!directory.Ok || directory.Value is null)
        {
            return directory;
        }

        string sddl = string.Concat(
            "O:", ShortForm(WellKnownSids.BuiltinAdministrators),
            "G:", ShortForm(WellKnownSids.BuiltinAdministrators),
            "D:P",
            "(A;;FA;;;", ShortForm(WellKnownSids.LocalSystem), ")",
            "(A;;FA;;;", ShortForm(WellKnownSids.BuiltinAdministrators), ")",
            "(A;;0x1200a9;;;", identity.Sid, ")");

        List<AceSnapshot> aces = [];
        foreach (AceSnapshot ace in directory.Value.ExpectedAces)
        {
            aces.Add(new AceSnapshot(ace.AceType, 0, ace.AccessMask, ace.Sid));
        }

        return Outcome<SecurityDescriptorPlan>.Success(new SecurityDescriptorPlan(
            sddl,
            WellKnownSids.BuiltinAdministrators,
            aces,
            inheritable: false));
    }

    /// <summary>
    /// Compares an object's actual descriptor, read back through its handle,
    /// against this plan. An existing component that does not match exactly is
    /// REFUSED, never repaired (ADR 0018 section 2.1). Repairing would mean
    /// adopting an object an attacker may have created, and adoption is the
    /// outcome create-only disposition exists to prevent.
    /// </summary>
    internal RefusalCode RequireExactMatch(SecuritySnapshot actual)
    {
        if (!actual.DaclPresent)
        {
            return RefusalCode.DaclMissingRequiredAce;
        }

        if (!string.Equals(actual.OwnerSid, OwnerSid, StringComparison.Ordinal))
        {
            return RefusalCode.OwnerUntrusted;
        }

        if (!actual.DaclIsProtected)
        {
            return RefusalCode.DaclInheritanceNotBlocked;
        }

        foreach (AceSnapshot ace in actual.Aces)
        {
            if (ace.IsInherited)
            {
                return RefusalCode.DaclInheritanceNotBlocked;
            }
        }

        if (actual.Aces.Count != ExpectedAces.Count)
        {
            return actual.Aces.Count > ExpectedAces.Count
                ? RefusalCode.DaclUnexpectedAce
                : RefusalCode.DaclMissingRequiredAce;
        }

        for (int index = 0; index < ExpectedAces.Count; index++)
        {
            AceSnapshot expected = ExpectedAces[index];
            AceSnapshot observed = actual.Aces[index];
            if (expected.AceType != observed.AceType ||
                expected.AccessMask != observed.AccessMask ||
                !string.Equals(expected.Sid, observed.Sid, StringComparison.Ordinal))
            {
                return RefusalCode.DaclUnexpectedAce;
            }

            // Inheritance flags are compared exactly too. An ACE that matched
            // in principal and mask but carried INHERIT_ONLY would grant
            // nothing on the object carrying it, so accepting it would accept a
            // directory whose SYSTEM and Administrators FullControl ACEs are
            // decorative.
            if (expected.AceFlags != observed.AceFlags)
            {
                return RefusalCode.DaclUnexpectedAce;
            }
        }

        return RefusalCode.None;
    }

    /// <summary>
    /// SDDL uses two-letter aliases for well-known principals and literal SID
    /// strings for everything else. Only the aliases this component actually
    /// emits are mapped; an unmapped SID falls through as its literal string,
    /// which SDDL also accepts.
    /// </summary>
    private static string ShortForm(string sid) => sid switch
    {
        WellKnownSids.LocalSystem => "SY",
        WellKnownSids.BuiltinAdministrators => "BA",
        _ => sid,
    };

    /// <summary>
    /// A conservative SID-string shape check. The SID is interpolated into an
    /// SDDL string, so it must not be able to introduce SDDL syntax; only
    /// digits, hyphens, and the leading <c>S-</c> are accepted.
    /// </summary>
    private static bool IsAcceptableSidSpelling(string sid)
    {
        if (sid.Length < 8 || sid.Length > 187 || !sid.StartsWith("S-1-", StringComparison.Ordinal))
        {
            return false;
        }

        foreach (char character in sid)
        {
            bool allowed = (character >= '0' && character <= '9') ||
                           character == '-' || character == 'S';
            if (!allowed)
            {
                return false;
            }
        }

        return sid[^1] != '-';
    }
}

/// <summary>One reviewed, installable proof candidate.</summary>
internal sealed class ProofCandidate
{
    internal ProofCandidate(
        string candidateId,
        string component,
        string bundleVersion,
        string buildFlavor,
        string manifestFingerprint,
        IReadOnlyList<string> fileNames)
    {
        CandidateId = candidateId;
        Component = component;
        BundleVersion = bundleVersion;
        BuildFlavor = buildFlavor;
        ManifestFingerprint = manifestFingerprint;
        FileNames = fileNames;
    }

    internal string CandidateId { get; }

    internal string Component { get; }

    internal string BundleVersion { get; }

    internal string BuildFlavor { get; }

    /// <summary>
    /// The fingerprint the source closure must recompute to. It is a compile-
    /// time constant of reviewed source. There is no argument, environment
    /// variable, configuration file, or manifest field that can add, replace,
    /// or relax it.
    /// </summary>
    internal string ManifestFingerprint { get; }

    internal IReadOnlyList<string> FileNames { get; }

    internal CanonicalObject ToCanonical() =>
        new CanonicalObject()
            .Set("buildFlavor", BuildFlavor)
            .Set("bundleVersion", BundleVersion)
            .Set("candidateId", CandidateId)
            .Set("component", Component)
            .Set("fileNames", FileNames)
            .Set("manifestFingerprint", ManifestFingerprint);
}

/// <summary>
/// The compiled-in proof configuration (ADR 0018 section 2.4).
///
/// <see cref="Installable"/> contains one reviewed Stage 17W runtime closure.
/// Its identifier, exact ordinal filename set, and source-envelope fingerprint
/// are literals in this binary. Adding or replacing a candidate therefore
/// requires a reviewed source change; no argument, environment value, source
/// manifest, or operator-supplied digest can extend the trust root.
/// </summary>
internal static class ProofConfiguration
{
    internal const string InstallRootFirstComponent = "AI-Dev-OS";
    internal const string InstallRootSecondComponent = "Stage17-Proof";
    internal const string InstalledManifestFileName = "stage17-proof-manifest.json";
    internal const string InstallRecordFileName = "stage17-proof-install-record.json";
    internal const int MaximumInstalledFileCount = 256;
    internal const long MaximumInstalledFileBytes = 268_435_456L;
    internal const int MaximumManifestBytes = 1_048_576;

    /// <summary>
    /// The filesystem this component is willing to operate on. Volume identity
    /// and file identity are only meaningful on a filesystem that supplies
    /// them, and a 128-bit file id is not available on FAT.
    /// </summary>
    internal const string RequiredFileSystemName = "NTFS";

    private static readonly ProofCandidate[] ReviewedTable =
    [
        new(
            "stage17w-runtime-v1",
            "windows-stage17-runtime",
            "1.0.0",
            "sealed",
            "16f327aa858f25e85c9f335d658e1879d1c93729940648df19cd6966326eb5c8",
            [
                "AI.DevOS.WindowsBoundaryFixture.exe",
                "AI.DevOS.WindowsHelper.deps.json",
                "AI.DevOS.WindowsHelper.dll",
                "AI.DevOS.WindowsHelper.exe",
                "AI.DevOS.WindowsHelper.runtimeconfig.json",
                "AI.DevOS.WindowsSupervisor.deps.json",
                "AI.DevOS.WindowsSupervisor.dll",
                "AI.DevOS.WindowsSupervisor.exe",
                "AI.DevOS.WindowsSupervisor.runtimeconfig.json",
                "Microsoft.CSharp.dll",
                "Microsoft.DiaSymReader.Native.amd64.dll",
                "Microsoft.VisualBasic.Core.dll",
                "Microsoft.VisualBasic.dll",
                "Microsoft.Win32.Primitives.dll",
                "Microsoft.Win32.Registry.dll",
                "System.AppContext.dll",
                "System.Buffers.dll",
                "System.Collections.Concurrent.dll",
                "System.Collections.Immutable.dll",
                "System.Collections.NonGeneric.dll",
                "System.Collections.Specialized.dll",
                "System.Collections.dll",
                "System.ComponentModel.Annotations.dll",
                "System.ComponentModel.DataAnnotations.dll",
                "System.ComponentModel.EventBasedAsync.dll",
                "System.ComponentModel.Primitives.dll",
                "System.ComponentModel.TypeConverter.dll",
                "System.ComponentModel.dll",
                "System.Configuration.dll",
                "System.Console.dll",
                "System.Core.dll",
                "System.Data.Common.dll",
                "System.Data.DataSetExtensions.dll",
                "System.Data.dll",
                "System.Diagnostics.Contracts.dll",
                "System.Diagnostics.Debug.dll",
                "System.Diagnostics.DiagnosticSource.dll",
                "System.Diagnostics.FileVersionInfo.dll",
                "System.Diagnostics.Process.dll",
                "System.Diagnostics.StackTrace.dll",
                "System.Diagnostics.TextWriterTraceListener.dll",
                "System.Diagnostics.Tools.dll",
                "System.Diagnostics.TraceSource.dll",
                "System.Diagnostics.Tracing.dll",
                "System.Drawing.Primitives.dll",
                "System.Drawing.dll",
                "System.Dynamic.Runtime.dll",
                "System.Formats.Asn1.dll",
                "System.Formats.Tar.dll",
                "System.Globalization.Calendars.dll",
                "System.Globalization.Extensions.dll",
                "System.Globalization.dll",
                "System.IO.Compression.Brotli.dll",
                "System.IO.Compression.FileSystem.dll",
                "System.IO.Compression.Native.dll",
                "System.IO.Compression.ZipFile.dll",
                "System.IO.Compression.dll",
                "System.IO.FileSystem.AccessControl.dll",
                "System.IO.FileSystem.DriveInfo.dll",
                "System.IO.FileSystem.Primitives.dll",
                "System.IO.FileSystem.Watcher.dll",
                "System.IO.FileSystem.dll",
                "System.IO.IsolatedStorage.dll",
                "System.IO.MemoryMappedFiles.dll",
                "System.IO.Pipelines.dll",
                "System.IO.Pipes.AccessControl.dll",
                "System.IO.Pipes.dll",
                "System.IO.UnmanagedMemoryStream.dll",
                "System.IO.dll",
                "System.Linq.Expressions.dll",
                "System.Linq.Parallel.dll",
                "System.Linq.Queryable.dll",
                "System.Linq.dll",
                "System.Memory.dll",
                "System.Net.Http.Json.dll",
                "System.Net.Http.dll",
                "System.Net.HttpListener.dll",
                "System.Net.Mail.dll",
                "System.Net.NameResolution.dll",
                "System.Net.NetworkInformation.dll",
                "System.Net.Ping.dll",
                "System.Net.Primitives.dll",
                "System.Net.Quic.dll",
                "System.Net.Requests.dll",
                "System.Net.Security.dll",
                "System.Net.ServicePoint.dll",
                "System.Net.Sockets.dll",
                "System.Net.WebClient.dll",
                "System.Net.WebHeaderCollection.dll",
                "System.Net.WebProxy.dll",
                "System.Net.WebSockets.Client.dll",
                "System.Net.WebSockets.dll",
                "System.Net.dll",
                "System.Numerics.Vectors.dll",
                "System.Numerics.dll",
                "System.ObjectModel.dll",
                "System.Private.CoreLib.dll",
                "System.Private.DataContractSerialization.dll",
                "System.Private.Uri.dll",
                "System.Private.Xml.Linq.dll",
                "System.Private.Xml.dll",
                "System.Reflection.DispatchProxy.dll",
                "System.Reflection.Emit.ILGeneration.dll",
                "System.Reflection.Emit.Lightweight.dll",
                "System.Reflection.Emit.dll",
                "System.Reflection.Extensions.dll",
                "System.Reflection.Metadata.dll",
                "System.Reflection.Primitives.dll",
                "System.Reflection.TypeExtensions.dll",
                "System.Reflection.dll",
                "System.Resources.Reader.dll",
                "System.Resources.ResourceManager.dll",
                "System.Resources.Writer.dll",
                "System.Runtime.CompilerServices.Unsafe.dll",
                "System.Runtime.CompilerServices.VisualC.dll",
                "System.Runtime.Extensions.dll",
                "System.Runtime.Handles.dll",
                "System.Runtime.InteropServices.JavaScript.dll",
                "System.Runtime.InteropServices.RuntimeInformation.dll",
                "System.Runtime.InteropServices.dll",
                "System.Runtime.Intrinsics.dll",
                "System.Runtime.Loader.dll",
                "System.Runtime.Numerics.dll",
                "System.Runtime.Serialization.Formatters.dll",
                "System.Runtime.Serialization.Json.dll",
                "System.Runtime.Serialization.Primitives.dll",
                "System.Runtime.Serialization.Xml.dll",
                "System.Runtime.Serialization.dll",
                "System.Runtime.dll",
                "System.Security.AccessControl.dll",
                "System.Security.Claims.dll",
                "System.Security.Cryptography.Algorithms.dll",
                "System.Security.Cryptography.Cng.dll",
                "System.Security.Cryptography.Csp.dll",
                "System.Security.Cryptography.Encoding.dll",
                "System.Security.Cryptography.OpenSsl.dll",
                "System.Security.Cryptography.Primitives.dll",
                "System.Security.Cryptography.X509Certificates.dll",
                "System.Security.Cryptography.dll",
                "System.Security.Principal.Windows.dll",
                "System.Security.Principal.dll",
                "System.Security.SecureString.dll",
                "System.Security.dll",
                "System.ServiceModel.Web.dll",
                "System.ServiceProcess.dll",
                "System.Text.Encoding.CodePages.dll",
                "System.Text.Encoding.Extensions.dll",
                "System.Text.Encoding.dll",
                "System.Text.Encodings.Web.dll",
                "System.Text.Json.dll",
                "System.Text.RegularExpressions.dll",
                "System.Threading.Channels.dll",
                "System.Threading.Overlapped.dll",
                "System.Threading.Tasks.Dataflow.dll",
                "System.Threading.Tasks.Extensions.dll",
                "System.Threading.Tasks.Parallel.dll",
                "System.Threading.Tasks.dll",
                "System.Threading.Thread.dll",
                "System.Threading.ThreadPool.dll",
                "System.Threading.Timer.dll",
                "System.Threading.dll",
                "System.Transactions.Local.dll",
                "System.Transactions.dll",
                "System.ValueTuple.dll",
                "System.Web.HttpUtility.dll",
                "System.Web.dll",
                "System.Windows.dll",
                "System.Xml.Linq.dll",
                "System.Xml.ReaderWriter.dll",
                "System.Xml.Serialization.dll",
                "System.Xml.XDocument.dll",
                "System.Xml.XPath.XDocument.dll",
                "System.Xml.XPath.dll",
                "System.Xml.XmlDocument.dll",
                "System.Xml.XmlSerializer.dll",
                "System.Xml.dll",
                "System.dll",
                "WindowsBase.dll",
                "clretwrc.dll",
                "clrgc.dll",
                "clrgcexp.dll",
                "clrjit.dll",
                "coreclr.dll",
                "createdump.exe",
                "hostfxr.dll",
                "hostpolicy.dll",
                "mscordaccore.dll",
                "mscordaccore_amd64_amd64_9.0.1826.31522.dll",
                "mscordbi.dll",
                "mscorlib.dll",
                "mscorrc.dll",
                "msquic.dll",
                "netstandard.dll",
            ]),
    ];

    /// <summary>
    /// A test-only candidate. It exists so the self-test can exercise the whole
    /// transaction against the simulated filesystem, and it is named for
    /// exactly what it is rather than being smuggled in as a real entry.
    ///
    /// It is NOT in <see cref="Installable"/>, and a self-test vector asserts
    /// that. If it ever appears there, the vector fails and the build fails,
    /// which is the property that keeps a test fixture from becoming a trust
    /// root by accident.
    /// </summary>
    internal static ProofCandidate SelfTestFixtureCandidate { get; } = new(
        "self-test-fixture-not-installable",
        "windows-supervisor",
        "1.0.0",
        "sealed",
        // A fixed literal, pinned here and recomputed by the self-test from the
        // fixture bytes. Comparing a computed envelope against a literal is the
        // point: an earlier checkpoint shipped a vector that compared one
        // function against itself and therefore could not fail (finding F2).
        "daa68e59680036fc6533c0a5c2a0a695bba64211140bab57f728633228b6ad73",
        ["alpha.dll", "beta.exe"]);

    /// <summary>
    /// The reviewed, installable candidates.
    /// </summary>
    internal static IReadOnlyList<ProofCandidate> Installable => ReviewedTable;

    /// <summary>
    /// Resolves a candidate id against the compiled-in table.
    ///
    /// The lookup is by IDENTIFIER, never by fingerprint. There is no overload
    /// that takes a digest, so no call site can be written that lets an
    /// operator introduce a new expected fingerprint by typing one.
    /// </summary>
    internal static Outcome<ProofCandidate> FindInstallable(string candidateId)
    {
        if (!NameGrammar.IsCandidateId(candidateId))
        {
            return Outcome<ProofCandidate>.Refused(RefusalCode.ArgumentInvalid);
        }

        ProofCandidate? found = null;
        foreach (ProofCandidate candidate in Installable)
        {
            if (string.Equals(candidate.CandidateId, candidateId, StringComparison.Ordinal))
            {
                if (found is not null)
                {
                    return Outcome<ProofCandidate>.Refused(RefusalCode.CandidateAmbiguous);
                }

                found = candidate;
            }
        }

        return found is null
            ? Outcome<ProofCandidate>.Refused(RefusalCode.CandidateUnknown)
            : Outcome<ProofCandidate>.Success(found);
    }

    internal static string Sha256Hex(byte[] bytes)
    {
        byte[] digest = SHA256.HashData(bytes);
        StringBuilder builder = new(digest.Length * 2);
        foreach (byte value in digest)
        {
            builder.Append(value.ToString("x2", CultureInfo.InvariantCulture));
        }

        return builder.ToString();
    }

    internal static string Sha256HexOfText(string text) =>
        Sha256Hex(new UTF8Encoding(encoderShouldEmitUTF8Identifier: false).GetBytes(text));
}

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace AiDevOs.WindowsSupervisor;

/// <summary>One enumerated file in the artifact closure.</summary>
internal sealed class ArtifactFileEntry
{
    internal ArtifactFileEntry(string name, long size, string sha256)
    {
        Name = name;
        Size = size;
        Sha256 = sha256;
    }

    internal string Name { get; }

    internal long Size { get; }

    internal string Sha256 { get; }

    internal CanonicalObject ToCanonical() =>
        new CanonicalObject()
            .Set("name", Name)
            .Set("sha256", Sha256)
            .Set("size", Size);
}

/// <summary>
/// The artifact manifest of ADR 0017 section 6.3.
///
/// A manifest sitting in the bundle it describes is an index, not evidence.
/// Verifying it proves internal consistency of a closure; only the reviewed
/// TypeScript control plane's pinned fingerprint table can decide that a
/// closure is the intended one, and in this checkpoint that table is empty.
/// </summary>
internal sealed class ArtifactManifest
{
    internal const string ManifestKind = "ai-dev-os-windows-production-artifact-manifest";
    internal const string UnsignedSignerState = "unsigned-candidate";

    internal ArtifactManifest(
        string component,
        int protocolVersion,
        string sourceVersion,
        int buildRecipeVersion,
        string platform,
        string rid,
        string architecture,
        string packageVersion,
        string bundleVersion,
        IReadOnlyList<ArtifactFileEntry> files,
        long totalBytes,
        string sourceEnvelopeFingerprint,
        string buildManifestFingerprint,
        int corpusVersion,
        string corpusFingerprint,
        int windowsApplicableVectorCount,
        string signerState,
        bool productionEligible,
        IReadOnlyList<string> limitations)
    {
        Component = component;
        ProtocolVersion = protocolVersion;
        SourceVersion = sourceVersion;
        BuildRecipeVersion = buildRecipeVersion;
        Platform = platform;
        Rid = rid;
        Architecture = architecture;
        PackageVersion = packageVersion;
        BundleVersion = bundleVersion;
        Files = files;
        TotalBytes = totalBytes;
        SourceEnvelopeFingerprint = sourceEnvelopeFingerprint;
        BuildManifestFingerprint = buildManifestFingerprint;
        CorpusVersion = corpusVersion;
        CorpusFingerprint = corpusFingerprint;
        WindowsApplicableVectorCount = windowsApplicableVectorCount;
        SignerState = signerState;
        ProductionEligible = productionEligible;
        Limitations = limitations;
    }

    internal string Component { get; }

    internal int ProtocolVersion { get; }

    internal string SourceVersion { get; }

    internal int BuildRecipeVersion { get; }

    internal string Platform { get; }

    internal string Rid { get; }

    internal string Architecture { get; }

    internal string PackageVersion { get; }

    internal string BundleVersion { get; }

    internal IReadOnlyList<ArtifactFileEntry> Files { get; }

    internal long TotalBytes { get; }

    internal string SourceEnvelopeFingerprint { get; }

    internal string BuildManifestFingerprint { get; }

    internal int CorpusVersion { get; }

    internal string CorpusFingerprint { get; }

    internal int WindowsApplicableVectorCount { get; }

    internal string SignerState { get; }

    internal bool ProductionEligible { get; }

    internal IReadOnlyList<string> Limitations { get; }

    internal CanonicalObject ToCanonical()
    {
        List<CanonicalObject> files = new(Files.Count);
        foreach (ArtifactFileEntry entry in Files)
        {
            files.Add(entry.ToCanonical());
        }

        return new CanonicalObject()
            .Set("architecture", Architecture)
            .Set("buildManifestFingerprint", BuildManifestFingerprint)
            .Set("buildRecipeVersion", BuildRecipeVersion)
            .Set("bundleVersion", BundleVersion)
            .Set("component", Component)
            .Set("corpusFingerprint", CorpusFingerprint)
            .Set("corpusVersion", CorpusVersion)
            .Set("fileCount", Files.Count)
            .Set("files", files)
            .Set("limitations", Limitations)
            .Set("manifestKind", ManifestKind)
            .Set("packageVersion", PackageVersion)
            .Set("platform", Platform)
            .Set("productionEligible", ProductionEligible)
            .Set("protocolVersion", ProtocolVersion)
            .Set("rid", Rid)
            .Set("schemaVersion", ProtocolContract.SchemaVersion)
            .Set("signerState", SignerState)
            .Set("sourceEnvelopeFingerprint", SourceEnvelopeFingerprint)
            .Set("sourceVersion", SourceVersion)
            .Set("totalBytes", TotalBytes)
            .Set("windowsApplicableVectorCount", WindowsApplicableVectorCount);
    }

    /// <summary>
    /// The recomputed manifest fingerprint. This is the value the reviewed
    /// TypeScript control plane compares against its pinned table; the manifest
    /// never carries its own fingerprint, because a self-asserted digest is not
    /// a trust root.
    /// </summary>
    internal string Fingerprint() => Sha256Hex(CanonicalJson.Serialize(ToCanonical()));

    /// <summary>Lowercase hexadecimal SHA-256 of a byte range.</summary>
    internal static string Sha256Hex(ReadOnlySpan<byte> content) => ToHex(SHA256.HashData(content));

    private static string ToHex(byte[] digest)
    {
        StringBuilder builder = new(digest.Length * 2);
        foreach (byte value in digest)
        {
            builder.Append(value.ToString("x2", CultureInfo.InvariantCulture));
        }

        return builder.ToString();
    }
}

/// <summary>Strict manifest parsing and closure verification.</summary>
internal static class ArtifactManifestReader
{
    private static readonly string[] ReservedDeviceNames =
    [
        "con", "prn", "aux", "nul",
        "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
        "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
    ];

    internal static bool TryParse(
        ReadOnlySpan<byte> payload,
        out ArtifactManifest manifest,
        out RefusalCode code)
    {
        manifest = EmptyManifest;
        if (payload.Length > ProtocolContract.MaxManifestBytes)
        {
            code = RefusalCode.ManifestTooLarge;
            return false;
        }

        if (!StrictJson.TryParseObject(payload, StrictLimits.Manifest, out StrictObject root, out code))
        {
            return false;
        }

        if (!root.TryTake("schemaVersion", StrictKind.Integer, out StrictValue schemaVersion, out code) ||
            schemaVersion.Integer != ProtocolContract.SchemaVersion ||
            !root.TryTake("manifestKind", StrictKind.String, out StrictValue manifestKind, out code) ||
            !string.Equals(manifestKind.Text, ArtifactManifest.ManifestKind, StringComparison.Ordinal))
        {
            code = RefusalCode.ManifestSchemaInvalid;
            return false;
        }

        if (!root.TryTake("component", StrictKind.String, out StrictValue component, out code) ||
            !root.TryTake("protocolVersion", StrictKind.Integer, out StrictValue protocolVersion, out code) ||
            !root.TryTake("sourceVersion", StrictKind.String, out StrictValue sourceVersion, out code) ||
            !root.TryTake("buildRecipeVersion", StrictKind.Integer, out StrictValue buildRecipeVersion, out code) ||
            !root.TryTake("platform", StrictKind.String, out StrictValue platform, out code) ||
            !root.TryTake("rid", StrictKind.String, out StrictValue rid, out code) ||
            !root.TryTake("architecture", StrictKind.String, out StrictValue architecture, out code) ||
            !root.TryTake("packageVersion", StrictKind.String, out StrictValue packageVersion, out code) ||
            !root.TryTake("bundleVersion", StrictKind.String, out StrictValue bundleVersion, out code) ||
            !root.TryTake("fileCount", StrictKind.Integer, out StrictValue fileCount, out code) ||
            !root.TryTake("totalBytes", StrictKind.Integer, out StrictValue totalBytes, out code) ||
            !root.TryTake("files", StrictKind.ObjectArray, out StrictValue files, out code) ||
            !root.TryTake("sourceEnvelopeFingerprint", StrictKind.String, out StrictValue sourceEnvelope, out code) ||
            !root.TryTake("buildManifestFingerprint", StrictKind.String, out StrictValue buildManifest, out code) ||
            !root.TryTake("corpusVersion", StrictKind.Integer, out StrictValue corpusVersion, out code) ||
            !root.TryTake("corpusFingerprint", StrictKind.String, out StrictValue corpusFingerprint, out code) ||
            !root.TryTake("windowsApplicableVectorCount", StrictKind.Integer, out StrictValue vectorCount, out code) ||
            !root.TryTake("signerState", StrictKind.String, out StrictValue signerState, out code) ||
            !root.TryTake("productionEligible", StrictKind.Boolean, out StrictValue productionEligible, out code) ||
            !root.TryTake("limitations", StrictKind.StringArray, out StrictValue limitations, out code))
        {
            code = RefusalCode.ManifestSchemaInvalid;
            return false;
        }

        if (!root.RequireExhausted(out code))
        {
            code = RefusalCode.ManifestSchemaInvalid;
            return false;
        }

        if (!TryReadFiles(files.Objects, out IReadOnlyList<ArtifactFileEntry> entries, out code))
        {
            return false;
        }

        if (entries.Count != fileCount.Integer)
        {
            code = RefusalCode.ManifestSchemaInvalid;
            return false;
        }

        long measured = 0;
        foreach (ArtifactFileEntry entry in entries)
        {
            measured += entry.Size;
        }

        if (measured != totalBytes.Integer)
        {
            code = RefusalCode.ManifestSchemaInvalid;
            return false;
        }

        if (!StrictJson.IsLowercaseHex(sourceEnvelope.Text, ProtocolContract.FingerprintHexLength) ||
            !StrictJson.IsLowercaseHex(buildManifest.Text, ProtocolContract.FingerprintHexLength) ||
            !StrictJson.IsLowercaseHex(corpusFingerprint.Text, ProtocolContract.FingerprintHexLength))
        {
            code = RefusalCode.ManifestSchemaInvalid;
            return false;
        }

        if (!ProtocolMessage.IsAcceptableBundleVersion(bundleVersion.Text) ||
            !ProtocolMessage.IsAcceptableBundleVersion(sourceVersion.Text) ||
            !ProtocolMessage.IsAcceptableBundleVersion(packageVersion.Text))
        {
            code = RefusalCode.ManifestSchemaInvalid;
            return false;
        }

        if (!IsSortedAscending(limitations.Strings))
        {
            code = RefusalCode.ManifestSchemaInvalid;
            return false;
        }

        manifest = new ArtifactManifest(
            component.Text ?? string.Empty,
            checked((int)protocolVersion.Integer),
            sourceVersion.Text ?? string.Empty,
            checked((int)buildRecipeVersion.Integer),
            platform.Text ?? string.Empty,
            rid.Text ?? string.Empty,
            architecture.Text ?? string.Empty,
            packageVersion.Text ?? string.Empty,
            bundleVersion.Text ?? string.Empty,
            entries,
            totalBytes.Integer,
            sourceEnvelope.Text ?? string.Empty,
            buildManifest.Text ?? string.Empty,
            checked((int)corpusVersion.Integer),
            corpusFingerprint.Text ?? string.Empty,
            checked((int)vectorCount.Integer),
            signerState.Text ?? string.Empty,
            productionEligible.Boolean,
            limitations.Strings ?? []);
        code = RefusalCode.None;
        return true;
    }

    private static bool TryReadFiles(
        IReadOnlyList<StrictObject>? objects,
        out IReadOnlyList<ArtifactFileEntry> entries,
        out RefusalCode code)
    {
        List<ArtifactFileEntry> parsed = [];
        entries = parsed;
        if (objects is null || objects.Count == 0)
        {
            code = RefusalCode.ManifestSchemaInvalid;
            return false;
        }

        if (objects.Count > ProtocolContract.MaxManifestFileCount)
        {
            code = RefusalCode.ManifestTooLarge;
            return false;
        }

        HashSet<string> exact = new(StringComparer.Ordinal);
        HashSet<string> caseInsensitive = new(StringComparer.OrdinalIgnoreCase);
        string? previous = null;

        foreach (StrictObject entry in objects)
        {
            if (!entry.TryTake("name", StrictKind.String, out StrictValue name, out code) ||
                !entry.TryTake("size", StrictKind.Integer, out StrictValue size, out code) ||
                !entry.TryTake("sha256", StrictKind.String, out StrictValue digest, out code) ||
                !entry.RequireExhausted(out code))
            {
                code = RefusalCode.ManifestSchemaInvalid;
                return false;
            }

            string fileName = name.Text ?? string.Empty;
            if (!IsAcceptableFileName(fileName))
            {
                code = RefusalCode.ManifestFileNameInvalid;
                return false;
            }

            if (size.Integer < 0 || size.Integer > ProtocolContract.MaxManifestFileBytes)
            {
                code = RefusalCode.ValueOutOfRange;
                return false;
            }

            if (!StrictJson.IsLowercaseHex(digest.Text, ProtocolContract.FingerprintHexLength))
            {
                code = RefusalCode.ManifestSchemaInvalid;
                return false;
            }

            // Exact duplicates and case-only duplicates are both refusals: on a
            // case-insensitive filesystem the second entry would silently
            // shadow the first.
            if (!exact.Add(fileName) || !caseInsensitive.Add(fileName))
            {
                code = RefusalCode.ManifestFileDuplicate;
                return false;
            }

            if (previous is not null && string.CompareOrdinal(previous, fileName) >= 0)
            {
                code = RefusalCode.ManifestSchemaInvalid;
                return false;
            }

            previous = fileName;
            parsed.Add(new ArtifactFileEntry(fileName, size.Integer, digest.Text ?? string.Empty));
        }

        code = RefusalCode.None;
        return true;
    }

    /// <summary>
    /// Closed-class file names: ASCII letters, digits, dot, dash, and
    /// underscore only. Restricting to ASCII structurally removes Unicode
    /// normalization ambiguity, and rejecting separators, drive letters, dot
    /// segments, streams, trailing dots or spaces, and reserved DOS device
    /// names removes path escape and device redirection.
    /// </summary>
    internal static bool IsAcceptableFileName(string? value)
    {
        if (value is null ||
            value.Length == 0 ||
            value.Length > ProtocolContract.MaxManifestFileNameLength)
        {
            return false;
        }

        // The first character must be alphanumeric. This matches the
        // TypeScript control plane's FILE_NAME_PATTERN exactly and rejects a
        // leading dot, dash, or underscore. A validator that is only almost
        // the same as its counterpart is a validator that disagrees somewhere.
        if (!char.IsAsciiLetterOrDigit(value[0]) || value[^1] == '.' || value[^1] == ' ')
        {
            return false;
        }

        foreach (char character in value)
        {
            bool acceptable = char.IsAsciiLetterOrDigit(character) ||
                character == '.' ||
                character == '-' ||
                character == '_';
            if (!acceptable)
            {
                return false;
            }
        }

        if (value.Contains("..", StringComparison.Ordinal))
        {
            return false;
        }

        int dot = value.IndexOf('.', StringComparison.Ordinal);
        string stem = dot < 0 ? value : value[..dot];
        foreach (string reserved in ReservedDeviceNames)
        {
            if (string.Equals(reserved, stem, StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }
        }

        return true;
    }

    private static bool IsSortedAscending(IReadOnlyList<string>? values)
    {
        if (values is null)
        {
            return false;
        }

        for (int index = 1; index < values.Count; index++)
        {
            if (string.CompareOrdinal(values[index - 1], values[index]) >= 0)
            {
                return false;
            }
        }

        return true;
    }

    private static ArtifactManifest EmptyManifest { get; } = new(
        "unknown",
        0,
        "0.0.0",
        0,
        "unknown",
        "unknown",
        "unknown",
        "0.0.0",
        "0.0.0",
        [],
        0,
        new string('0', ProtocolContract.FingerprintHexLength),
        new string('0', ProtocolContract.FingerprintHexLength),
        0,
        new string('0', ProtocolContract.FingerprintHexLength),
        0,
        ArtifactManifest.UnsignedSignerState,
        false,
        []);
}

/// <summary>
/// Verifies a manifest against the component's own identity and against the
/// actual closure. Section 6.5 order: identity first, then enumeration, then
/// per-file size and digest.
/// </summary>
internal static class ArtifactManifestVerifier
{
    internal static RefusalCode VerifyIdentity(ArtifactManifest manifest)
    {
        if (!string.Equals(manifest.Component, ComponentIdentity.ComponentName, StringComparison.Ordinal) ||
            manifest.ProtocolVersion != ProtocolContract.ProtocolVersion ||
            !string.Equals(manifest.SourceVersion, ComponentIdentity.SourceVersion, StringComparison.Ordinal) ||
            manifest.BuildRecipeVersion != ComponentIdentity.BuildRecipeVersion ||
            !string.Equals(manifest.Rid, ComponentIdentity.RuntimeIdentifier, StringComparison.Ordinal) ||
            !string.Equals(manifest.Platform, ComponentIdentity.Platform, StringComparison.Ordinal) ||
            !string.Equals(manifest.Architecture, ComponentIdentity.Architecture, StringComparison.Ordinal))
        {
            return RefusalCode.ManifestIdentityMismatch;
        }

        // Nothing in this checkpoint may claim production eligibility, and a
        // manifest that says it is signed is refused because no signing exists.
        if (manifest.ProductionEligible ||
            !string.Equals(manifest.SignerState, ArtifactManifest.UnsignedSignerState, StringComparison.Ordinal))
        {
            return RefusalCode.ManifestIdentityMismatch;
        }

        return RefusalCode.None;
    }

    /// <summary>
    /// Verifies a closure and immediately discards the ownership it acquired.
    ///
    /// This is a <em>diagnostic</em>, not the execution path, and the
    /// distinction is the whole point of ADR 0017 section 6.5. It answers "was
    /// this closure correct a moment ago", which is all a caller that does not
    /// go on to create a process can honestly claim. Any path that then creates
    /// a process must instead hold the lease from
    /// <see cref="VerifiedClosureLease.TryAcquire"/> open across
    /// <c>CreateProcessW</c>; using this method before creating a process would
    /// reintroduce exactly the defect the lease replaced.
    /// </summary>
    internal static RefusalCode VerifyClosureWithoutRetainingOwnership(
        ArtifactManifest manifest,
        IVerifiedClosureSource source)
    {
        using ClosureLeaseResult result = VerifiedClosureLease.Acquire(manifest, source);
        return result.Code;
    }
}

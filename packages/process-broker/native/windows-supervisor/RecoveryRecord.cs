using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace AiDevOs.WindowsSupervisor;

/// <summary>
/// One write-ahead recovery record (ADR 0017 section 5).
///
/// The record is a value: constructing, serializing, digesting, and validating
/// it never touches the filesystem. The supervisor writes records before the
/// native step they describe; this checkpoint implements only the format and
/// the reader, because writing a record is a mutating operation and is gated.
/// </summary>
internal sealed class RecoveryRecord
{
    internal RecoveryRecord(
        string component,
        string operationToken,
        OperationState phase,
        long sequence,
        string bundleVersion)
    {
        Component = component;
        OperationToken = operationToken;
        Phase = phase;
        Sequence = sequence;
        BundleVersion = bundleVersion;
    }

    internal string Component { get; }

    internal string OperationToken { get; }

    internal OperationState Phase { get; }

    internal long Sequence { get; }

    internal string BundleVersion { get; }

    internal string ProfileName => TokenDerivation.ProfileName(OperationToken);

    internal string StagingRootLeaf => TokenDerivation.StagingRootLeaf(OperationToken);

    internal IReadOnlyList<string> StagedFileNames =>
        TokenDerivation.StagedFileNames(OperationToken);

    /// <summary>
    /// The canonical form. Derived names are written into the record so a
    /// reader can prove the writer derived the same values, but a reader never
    /// trusts them: it recomputes them from the token and refuses on
    /// disagreement.
    /// </summary>
    internal CanonicalObject ToCanonical() =>
        new CanonicalObject()
            .Set("bundleVersion", BundleVersion)
            .Set("component", Component)
            .Set("operationToken", OperationToken)
            .Set("phase", ProtocolNames.Of(Phase))
            .Set("profileName", ProfileName)
            .Set("recordVersion", ProtocolContract.ProtocolVersion)
            .Set("schemaVersion", ProtocolContract.SchemaVersion)
            .Set("sequence", Sequence)
            .Set("stagedFileNames", StagedFileNames)
            .Set("stagingRootLeaf", StagingRootLeaf);
}

/// <summary>A journal read back from bytes, with its validation verdict.</summary>
internal sealed class RecoveryJournal
{
    internal RecoveryJournal(
        IReadOnlyList<RecoveryRecord> records,
        bool truncatedTrailingRecordDiscarded)
    {
        Records = records;
        TruncatedTrailingRecordDiscarded = truncatedTrailingRecordDiscarded;
    }

    internal IReadOnlyList<RecoveryRecord> Records { get; }

    internal bool TruncatedTrailingRecordDiscarded { get; }

    internal OperationState LastPhase =>
        Records.Count == 0 ? OperationState.None : Records[^1].Phase;

    /// <summary>
    /// An operation that never reached <c>cleanup-complete</c> is recoverable.
    /// A journal that did reach it is stale evidence of a finished operation
    /// and must not cause any cleanup action.
    /// </summary>
    internal bool RequiresRecovery => LastPhase != OperationState.CleanupComplete;
}

/// <summary>
/// Canonical serialization, digesting, framing, truncation detection, and
/// strict reading of recovery journals. Every function here is pure over byte
/// buffers and is exercised by the in-memory self-test.
/// </summary>
internal static class RecoveryRecordCodec
{
    internal static byte[] SerializeCanonical(RecoveryRecord record) =>
        CanonicalJson.Serialize(record.ToCanonical());

    /// <summary>
    /// The record digest covers the length prefix as well as the canonical
    /// bytes, so a record cannot be re-framed under a different declared length
    /// and still verify.
    /// </summary>
    internal static byte[] Digest(ReadOnlySpan<byte> canonical)
    {
        byte[] prefixed = new byte[ProtocolContract.FrameLengthPrefixBytes + canonical.Length];
        BinaryPrimitives.WriteUInt32LittleEndian(prefixed, (uint)canonical.Length);
        canonical.CopyTo(prefixed.AsSpan(ProtocolContract.FrameLengthPrefixBytes));
        return SHA256.HashData(prefixed);
    }

    internal static string DigestHex(ReadOnlySpan<byte> canonical)
    {
        byte[] digest = Digest(canonical);
        StringBuilder builder = new(digest.Length * 2);
        foreach (byte value in digest)
        {
            builder.Append(value.ToString("x2", CultureInfo.InvariantCulture));
        }

        return builder.ToString();
    }

    internal static byte[] Frame(RecoveryRecord record)
    {
        byte[] canonical = SerializeCanonical(record);
        byte[] digest = Digest(canonical);
        byte[] framed = new byte[
            ProtocolContract.FrameLengthPrefixBytes + canonical.Length + digest.Length];
        BinaryPrimitives.WriteUInt32LittleEndian(framed, (uint)canonical.Length);
        canonical.CopyTo(framed.AsSpan(ProtocolContract.FrameLengthPrefixBytes));
        digest.CopyTo(framed.AsSpan(ProtocolContract.FrameLengthPrefixBytes + canonical.Length));
        return framed;
    }

    /// <summary>
    /// Reads a complete journal. <paramref name="expectedToken"/> is the token
    /// the journal file name derives from; a record naming a different token is
    /// a refusal, not a second operation.
    /// </summary>
    internal static bool TryRead(
        ReadOnlySpan<byte> buffer,
        string expectedToken,
        out RecoveryJournal journal,
        out RefusalCode code)
    {
        journal = new RecoveryJournal([], false);
        if (!TokenDerivation.IsValidOperationToken(expectedToken))
        {
            code = RefusalCode.TokenMalformed;
            return false;
        }

        List<RecoveryRecord> records = [];
        bool truncated = false;
        int offset = 0;
        long previousSequence = 0;
        OperationState previousPhase = OperationState.None;

        while (offset < buffer.Length)
        {
            int remaining = buffer.Length - offset;
            if (remaining < ProtocolContract.FrameLengthPrefixBytes)
            {
                truncated = true;
                break;
            }

            uint declared = BinaryPrimitives.ReadUInt32LittleEndian(
                buffer.Slice(offset, ProtocolContract.FrameLengthPrefixBytes));
            if (declared == 0 || declared > ProtocolContract.MaxRecoveryRecordBytes)
            {
                code = RefusalCode.RecoveryRecordSchemaInvalid;
                return false;
            }

            long needed = ProtocolContract.FrameLengthPrefixBytes +
                (long)declared +
                ProtocolContract.RecoveryDigestBytes;
            if (remaining < needed)
            {
                truncated = true;
                break;
            }

            int canonicalStart = offset + ProtocolContract.FrameLengthPrefixBytes;
            ReadOnlySpan<byte> canonical = buffer.Slice(canonicalStart, (int)declared);
            ReadOnlySpan<byte> storedDigest = buffer.Slice(
                canonicalStart + (int)declared,
                ProtocolContract.RecoveryDigestBytes);

            byte[] computed = Digest(canonical);
            if (!CryptographicOperations.FixedTimeEquals(computed, storedDigest))
            {
                code = RefusalCode.RecoveryRecordDigestMismatch;
                return false;
            }

            if (!TryParseRecord(canonical, expectedToken, out RecoveryRecord record, out code))
            {
                return false;
            }

            if (record.Sequence <= previousSequence)
            {
                code = RefusalCode.RecoveryRecordSequenceInvalid;
                return false;
            }

            if (record.Phase <= previousPhase)
            {
                code = RefusalCode.StateOutOfOrder;
                return false;
            }

            previousSequence = record.Sequence;
            previousPhase = record.Phase;
            records.Add(record);
            if (records.Count > ProtocolContract.MaxRecoveryRecordsPerJournal)
            {
                code = RefusalCode.RecoveryJournalOverlong;
                return false;
            }

            offset += (int)needed;
        }

        journal = new RecoveryJournal(records, truncated);
        code = RefusalCode.None;
        return true;
    }

    private static bool TryParseRecord(
        ReadOnlySpan<byte> canonical,
        string expectedToken,
        out RecoveryRecord record,
        out RefusalCode code)
    {
        record = new RecoveryRecord("unknown", expectedToken, OperationState.None, 0, "0.0.0");

        if (!StrictJson.TryParseObject(canonical, out StrictObject root, out code))
        {
            code = RefusalCode.RecoveryRecordSchemaInvalid;
            return false;
        }

        if (!root.TryTake("schemaVersion", StrictKind.Integer, out StrictValue schemaVersion, out code) ||
            schemaVersion.Integer != ProtocolContract.SchemaVersion ||
            !root.TryTake("recordVersion", StrictKind.Integer, out StrictValue recordVersion, out code) ||
            recordVersion.Integer != ProtocolContract.ProtocolVersion)
        {
            code = RefusalCode.RecoveryRecordSchemaInvalid;
            return false;
        }

        if (!root.TryTake("component", StrictKind.String, out StrictValue component, out code) ||
            !root.TryTake("operationToken", StrictKind.String, out StrictValue token, out code) ||
            !root.TryTake("phase", StrictKind.String, out StrictValue phase, out code) ||
            !root.TryTake("sequence", StrictKind.Integer, out StrictValue sequence, out code) ||
            !root.TryTake("bundleVersion", StrictKind.String, out StrictValue bundleVersion, out code) ||
            !root.TryTake("profileName", StrictKind.String, out StrictValue profileName, out code) ||
            !root.TryTake("stagingRootLeaf", StrictKind.String, out StrictValue stagingRoot, out code) ||
            !root.TryTake("stagedFileNames", StrictKind.StringArray, out StrictValue stagedFiles, out code))
        {
            code = RefusalCode.RecoveryRecordSchemaInvalid;
            return false;
        }

        if (!root.RequireExhausted(out code))
        {
            code = RefusalCode.RecoveryRecordSchemaInvalid;
            return false;
        }

        if (!string.Equals(token.Text, expectedToken, StringComparison.Ordinal))
        {
            code = RefusalCode.RecoveryRecordTokenMismatch;
            return false;
        }

        if (!ProtocolNames.TryParseState(phase.Text ?? string.Empty, out OperationState parsedPhase))
        {
            code = RefusalCode.RecoveryRecordSchemaInvalid;
            return false;
        }

        if (sequence.Integer is < 1 or > ProtocolContract.MaxRecoveryRecordsPerJournal)
        {
            code = RefusalCode.RecoveryRecordSequenceInvalid;
            return false;
        }

        if (!ProtocolMessage.IsAcceptableBundleVersion(bundleVersion.Text) ||
            !IsAcceptableComponentName(component.Text))
        {
            code = RefusalCode.RecoveryRecordSchemaInvalid;
            return false;
        }

        // Paths in the journal are never trusted. Everything the record claims
        // about names is recomputed from the token and compared.
        if (!string.Equals(profileName.Text, TokenDerivation.ProfileName(expectedToken), StringComparison.Ordinal) ||
            !string.Equals(stagingRoot.Text, TokenDerivation.StagingRootLeaf(expectedToken), StringComparison.Ordinal) ||
            !TokenDerivation.StagedFileNamesEqual(stagedFiles.Strings, expectedToken))
        {
            code = RefusalCode.RecoveryRecordPathMismatch;
            return false;
        }

        record = new RecoveryRecord(
            component.Text ?? string.Empty,
            expectedToken,
            parsedPhase,
            sequence.Integer,
            bundleVersion.Text ?? string.Empty);
        code = RefusalCode.None;
        return true;
    }

    /// <summary>
    /// A journal whose token is in the live set belongs to a running operation.
    /// Recovery skips it, so an old restored journal cannot target live state.
    /// </summary>
    internal static bool IsActionable(
        string operationToken,
        RecoveryJournal journal,
        IReadOnlyCollection<string> liveTokens)
    {
        if (!journal.RequiresRecovery)
        {
            return false;
        }

        foreach (string live in liveTokens)
        {
            if (string.Equals(live, operationToken, StringComparison.Ordinal))
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// Only the two production components are acceptable.
    ///
    /// The TypeScript reader accepts exactly this closed set. Accepting any
    /// lowercase-and-hyphen string here, as an earlier revision did, would have
    /// let a journal name a component that does not exist and still parse on
    /// one side of the boundary but not the other.
    /// </summary>
    private static bool IsAcceptableComponentName(string? value) =>
        string.Equals(value, "windows-supervisor", StringComparison.Ordinal) ||
        string.Equals(value, "windows-helper", StringComparison.Ordinal);
}

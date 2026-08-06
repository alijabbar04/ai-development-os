using System;
using System.Collections.Generic;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace AiDevOs.WindowsHelper;

/// <summary>One named self-test vector and its observed result.</summary>
internal sealed class ConformanceVector
{
    internal ConformanceVector(string name, string expected, string observed)
    {
        Name = name;
        Expected = expected;
        Observed = observed;
    }

    internal string Name { get; }

    internal string Expected { get; }

    internal string Observed { get; }

    internal bool Passed => string.Equals(Expected, Observed, StringComparison.Ordinal);

    internal CanonicalObject ToCanonical() =>
        new CanonicalObject()
            .Set("expected", Expected)
            .Set("name", Name)
            .Set("observed", Observed);
}

/// <summary>An ordered vector set plus its stable digest.</summary>
internal sealed class ConformanceReport
{
    internal ConformanceReport(string suite, IReadOnlyList<ConformanceVector> vectors)
    {
        Suite = suite;
        Vectors = vectors;

        List<string> failed = [];
        List<CanonicalObject> canonical = new(vectors.Count);
        foreach (ConformanceVector vector in vectors)
        {
            canonical.Add(vector.ToCanonical());
            if (!vector.Passed)
            {
                failed.Add(vector.Name);
            }
        }

        FailedNames = failed;
        CanonicalObject envelope = new CanonicalObject()
            .Set("suite", suite)
            .Set("suiteVersion", ProtocolContract.ProtocolVersion)
            .Set("vectors", canonical);
        Digest = ArtifactManifest.Sha256Hex(CanonicalJson.Serialize(envelope));
    }

    internal string Suite { get; }

    internal IReadOnlyList<ConformanceVector> Vectors { get; }

    internal IReadOnlyList<string> FailedNames { get; }

    internal string Digest { get; }

    internal int Count => Vectors.Count;

    internal int FailedCount => FailedNames.Count;

    internal bool Passed => FailedCount == 0;
}

/// <summary>
/// The in-memory conformance suite shared by both components.
///
/// It exercises framing bounds, strict parsing, the protocol message grammar,
/// the state machine, canonical serialization, the recovery-record format, and
/// artifact-manifest identity and closure logic. Nothing in this file opens a
/// file, creates a process, touches the registry, reads the environment, or
/// allocates any host resource: every vector runs over byte arrays held in
/// memory, which is what makes `self-test` structurally read-only.
///
/// The vector set is identical in the supervisor and the helper, so the digest
/// both components report must be equal. The packaging pipeline compares them
/// and fails the build if the two shared cores have drifted apart.
/// </summary>
internal static class CoreConformance
{
    private const string Token = "0123456789abcdef0123456789abcdef";
    private const string OtherToken = "fedcba9876543210fedcba9876543210";
    private const string FixtureComponent = "windows-supervisor";
    private const string FixtureBundleVersion = "1.0.0";

    private static readonly UTF8Encoding Utf8 = new(encoderShouldEmitUTF8Identifier: false);

    internal static ConformanceReport Run()
    {
        List<ConformanceVector> vectors = [];
        AddFramingVectors(vectors);
        AddStrictJsonVectors(vectors);
        AddMessageVectors(vectors);
        AddStateMachineVectors(vectors);
        AddCanonicalVectors(vectors);
        AddTokenVectors(vectors);
        AddRecoveryVectors(vectors);
        AddManifestVectors(vectors);
        vectors.Add(new ConformanceVector(
            "gate/mutating-operations-structurally-disabled",
            "false",
            MutationGate.MutatingOperationsPermitted ? "true" : "false"));
        return new ConformanceReport("windows-production-core-v1", vectors);
    }

    // ---------------------------------------------------------------- framing

    private static void AddFramingVectors(List<ConformanceVector> vectors)
    {
        byte[] payload = Utf8.GetBytes("{\"a\":1}");
        vectors.Add(Vector("frame/roundtrip", "ok:7", ReadOne(FrameCodec.Encode(payload))));
        vectors.Add(Vector(
            "frame/zero-declared-length",
            "refused:frame-empty",
            ReadOne(FrameCodec.EncodeWithDeclaredLength(payload, 0))));
        vectors.Add(Vector(
            "frame/declared-length-over-maximum",
            "refused:frame-too-large",
            ReadOne(FrameCodec.EncodeWithDeclaredLength(
                payload,
                ProtocolContract.MaxFramePayloadBytes + 1))));
        vectors.Add(Vector("frame/truncated-prefix", "refused:frame-truncated", ReadOne([1, 2, 3])));
        vectors.Add(Vector(
            "frame/truncated-payload",
            "refused:frame-truncated",
            ReadOne(FrameCodec.EncodeWithDeclaredLength(payload, (uint)payload.Length + 1))));
        vectors.Add(Vector(
            "frame/exact-maximum-payload-accepted",
            "ok:8192",
            ReadOne(FrameCodec.Encode(new byte[ProtocolContract.MaxFramePayloadBytes]))));
        vectors.Add(Vector(
            "frame/count-limit",
            "refused:frame-count-exceeded",
            ReadRepeated(payload, ProtocolContract.MaxFramesPerConnection + 1)));
        vectors.Add(Vector(
            "frame/connection-byte-limit",
            "refused:connection-bytes-exceeded",
            ReadRepeated(new byte[ProtocolContract.MaxFramePayloadBytes], 32)));
    }

    private static string ReadOne(byte[] buffer)
    {
        FrameReader reader = new();
        int offset = 0;
        if (!reader.TryReadNext(buffer, ref offset, out ReadOnlyMemory<byte> frame, out RefusalCode code))
        {
            return string.Concat("refused:", ProtocolNames.Of(code));
        }

        return string.Concat("ok:", frame.Length.ToString(CultureInfo.InvariantCulture));
    }

    private static string ReadRepeated(byte[] payload, int count)
    {
        byte[] frame = FrameCodec.Encode(payload);
        byte[] buffer = new byte[frame.Length * count];
        for (int index = 0; index < count; index++)
        {
            frame.CopyTo(buffer, index * frame.Length);
        }

        FrameReader reader = new();
        int offset = 0;
        for (int index = 0; index < count; index++)
        {
            if (!reader.TryReadNext(buffer, ref offset, out _, out RefusalCode code))
            {
                return string.Concat("refused:", ProtocolNames.Of(code));
            }
        }

        return string.Concat("ok:", reader.FrameCount.ToString(CultureInfo.InvariantCulture));
    }

    // ------------------------------------------------------------ strict JSON

    private static void AddStrictJsonVectors(List<ConformanceVector> vectors)
    {
        vectors.Add(Vector("json/valid-object", "ok:1", ParseRaw(Utf8.GetBytes("{\"a\":1}"))));
        vectors.Add(Vector(
            "json/invalid-utf8",
            "refused:invalid-utf8",
            ParseRaw([0x7B, 0x22, 0x61, 0x22, 0x3A, 0x22, 0xFF, 0x22, 0x7D])));
        vectors.Add(Vector(
            "json/byte-order-mark",
            "refused:invalid-utf8",
            ParseRaw([0xEF, 0xBB, 0xBF, 0x7B, 0x7D])));
        vectors.Add(Vector("json/trailing-content", "refused:invalid-json", Parse("{\"a\":1} {}")));
        vectors.Add(Vector("json/trailing-comma", "refused:invalid-json", Parse("{\"a\":1,}")));
        vectors.Add(Vector("json/comment", "refused:invalid-json", Parse("{/*x*/\"a\":1}")));
        vectors.Add(Vector("json/non-object-root", "refused:type-mismatch", Parse("[1,2]")));
        vectors.Add(Vector("json/duplicate-property", "refused:duplicate-property", Parse("{\"a\":1,\"a\":2}")));
        vectors.Add(Vector(
            "json/forbidden-proto",
            "refused:forbidden-property-name",
            Parse("{\"__proto__\":1}")));
        vectors.Add(Vector(
            "json/forbidden-constructor",
            "refused:forbidden-property-name",
            Parse("{\"constructor\":1}")));
        vectors.Add(Vector(
            "json/forbidden-prototype",
            "refused:forbidden-property-name",
            Parse("{\"prototype\":1}")));
        vectors.Add(Vector(
            "json/forbidden-proto-nested",
            "refused:forbidden-property-name",
            Parse("{\"a\":{\"__proto__\":1}}")));
        vectors.Add(Vector("json/fractional-number", "refused:value-out-of-range", Parse("{\"a\":1.5}")));
        vectors.Add(Vector("json/exponent-number", "refused:value-out-of-range", Parse("{\"a\":1e3}")));
        vectors.Add(Vector("json/uppercase-property", "refused:unknown-property", Parse("{\"A\":1}")));
        vectors.Add(Vector("json/underscore-property", "refused:unknown-property", Parse("{\"a_b\":1}")));
        vectors.Add(Vector(
            "json/depth-exceeded",
            "refused:json-depth-exceeded",
            Parse("{\"a\":{\"b\":{\"c\":{\"d\":{\"e\":{\"f\":1}}}}}}")));
        vectors.Add(Vector(
            "json/oversized-string",
            "refused:value-out-of-range",
            Parse(string.Concat("{\"a\":\"", new string('x', ProtocolContract.MaxStringLength + 1), "\"}"))));
        vectors.Add(Vector(
            "json/heterogeneous-array",
            "refused:type-mismatch",
            Parse("{\"a\":[\"x\",1]}")));
        vectors.Add(Vector(
            "json/object-array-refused-in-protocol-limits",
            "refused:type-mismatch",
            Parse("{\"a\":[{\"b\":1}]}")));
    }

    private static string Parse(string json) => ParseRaw(Utf8.GetBytes(json));

    private static string ParseRaw(byte[] payload)
    {
        if (!StrictJson.TryParseObject(payload, out StrictObject root, out RefusalCode code))
        {
            return string.Concat("refused:", ProtocolNames.Of(code));
        }

        return string.Concat("ok:", root.Count.ToString(CultureInfo.InvariantCulture));
    }

    // --------------------------------------------------------------- messages

    private static string Hex(char filler) => new(filler, ProtocolContract.FingerprintHexLength);

    private static string SetupJson(
        string token = Token,
        string endpointPolicy = "\"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\"",
        string bundleVersion = FixtureBundleVersion,
        string extraRootMember = "",
        string bindingsOverride = "")
    {
        string bindings = bindingsOverride.Length > 0
            ? bindingsOverride
            : string.Concat(
                "{\"request\":\"", Hex('a'), "\",",
                "\"grant\":\"", Hex('b'), "\",",
                "\"policy\":\"", Hex('c'), "\",",
                "\"lease\":\"", Hex('d'), "\",",
                "\"workspace\":\"", Hex('e'), "\",",
                "\"tool\":\"", Hex('f'), "\",",
                "\"endpointPolicy\":", endpointPolicy, ",",
                "\"quotas\":\"", Hex('0'), "\"}");

        return string.Concat(
            "{\"protocolVersion\":1,\"schemaVersion\":1,\"type\":\"setup-request\",",
            "\"operationToken\":\"", token, "\",",
            "\"bindings\":", bindings, ",",
            "\"identities\":{\"supervisor\":\"", Hex('1'), "\",\"helper\":\"", Hex('2'),
            "\",\"build\":\"", Hex('3'), "\"},",
            "\"bundleVersion\":\"", bundleVersion, "\"", extraRootMember, "}");
    }

    private static string StateJson(string state, long sequence, string token = Token) =>
        string.Concat(
            "{\"protocolVersion\":1,\"schemaVersion\":1,\"type\":\"state-report\",",
            "\"operationToken\":\"", token, "\",\"state\":\"", state,
            "\",\"sequence\":", sequence.ToString(CultureInfo.InvariantCulture), "}");

    private static string CancelJson(string token = Token) =>
        string.Concat(
            "{\"protocolVersion\":1,\"schemaVersion\":1,\"type\":\"cancel\",",
            "\"operationToken\":\"", token, "\"}");

    private static void AddMessageVectors(List<ConformanceVector> vectors)
    {
        vectors.Add(Vector("message/setup-valid", "ok:setup-request", ParseMessage(SetupJson())));
        vectors.Add(Vector(
            "message/setup-null-endpoint-policy",
            "ok:setup-request",
            ParseMessage(SetupJson(endpointPolicy: "null"))));
        vectors.Add(Vector(
            "message/setup-unknown-root-property",
            "refused:unknown-property",
            ParseMessage(SetupJson(extraRootMember: ",\"extra\":1"))));
        vectors.Add(Vector(
            "message/setup-unknown-binding",
            "refused:unknown-property",
            ParseMessage(SetupJson(bindingsOverride: string.Concat(
                "{\"request\":\"", Hex('a'), "\",\"grant\":\"", Hex('b'),
                "\",\"policy\":\"", Hex('c'), "\",\"lease\":\"", Hex('d'),
                "\",\"workspace\":\"", Hex('e'), "\",\"tool\":\"", Hex('f'),
                "\",\"endpointPolicy\":null,\"quotas\":\"", Hex('0'),
                "\",\"surprise\":\"", Hex('0'), "\"}")))));
        vectors.Add(Vector(
            "message/setup-missing-binding",
            "refused:missing-property",
            ParseMessage(SetupJson(bindingsOverride: string.Concat(
                "{\"request\":\"", Hex('a'), "\",\"grant\":\"", Hex('b'),
                "\",\"policy\":\"", Hex('c'), "\",\"lease\":\"", Hex('d'),
                "\",\"workspace\":\"", Hex('e'), "\",\"tool\":\"", Hex('f'),
                "\",\"endpointPolicy\":null}")))));
        vectors.Add(Vector(
            "message/setup-short-token",
            "refused:token-malformed",
            ParseMessage(SetupJson(token: "0123456789abcdef"))));
        vectors.Add(Vector(
            "message/setup-uppercase-token",
            "refused:token-malformed",
            ParseMessage(SetupJson(token: "0123456789ABCDEF0123456789abcdef"))));
        vectors.Add(Vector(
            "message/setup-short-fingerprint",
            "refused:value-out-of-range",
            ParseMessage(SetupJson(endpointPolicy: "\"abc\""))));
        vectors.Add(Vector(
            "message/setup-bundle-version-invalid",
            "refused:value-out-of-range",
            ParseMessage(SetupJson(bundleVersion: "1.0"))));
        vectors.Add(Vector(
            "message/setup-bundle-version-prerelease",
            "ok:setup-request",
            ParseMessage(SetupJson(bundleVersion: "1.0.0-rc.1"))));
        vectors.Add(Vector(
            "message/unknown-type",
            "refused:unknown-message-type",
            ParseMessage(
                "{\"protocolVersion\":1,\"schemaVersion\":1,\"type\":\"execute\"," +
                "\"operationToken\":\"" + Token + "\"}")));
        vectors.Add(Vector(
            "message/protocol-version-mismatch",
            "refused:protocol-version-mismatch",
            ParseMessage(
                "{\"protocolVersion\":2,\"schemaVersion\":1,\"type\":\"cancel\"," +
                "\"operationToken\":\"" + Token + "\"}")));
        vectors.Add(Vector(
            "message/schema-version-mismatch",
            "refused:schema-version-mismatch",
            ParseMessage(
                "{\"protocolVersion\":1,\"schemaVersion\":2,\"type\":\"cancel\"," +
                "\"operationToken\":\"" + Token + "\"}")));
        vectors.Add(Vector(
            "message/state-unknown",
            "refused:state-unknown",
            ParseMessage(StateJson("target-escaped", 1))));
        vectors.Add(Vector(
            "message/state-sequence-out-of-range",
            "refused:value-out-of-range",
            ParseMessage(StateJson("setup-complete", 0))));
        vectors.Add(Vector(
            "message/refusal-unknown-code",
            "refused:value-out-of-range",
            ParseMessage(
                "{\"protocolVersion\":1,\"schemaVersion\":1,\"type\":\"refusal\"," +
                "\"operationToken\":\"" + Token + "\",\"code\":\"because-i-said-so\"}")));
        vectors.Add(Vector(
            "message/refusal-serialization-is-body-free",
            "{\"code\":\"token-mismatch\",\"operationToken\":\"" + Token +
            "\",\"protocolVersion\":1,\"schemaVersion\":1,\"type\":\"refusal\"}",
            Utf8.GetString(ProtocolMessage.SerializeRefusal(Token, RefusalCode.TokenMismatch))));
        vectors.Add(Vector(
            "message/refusal-roundtrip",
            "ok:refusal",
            ParseMessage(Utf8.GetString(
                ProtocolMessage.SerializeRefusal(Token, RefusalCode.DeadlineExceeded)))));
    }

    private static string ParseMessage(string json)
    {
        if (!ProtocolMessage.TryParse(Utf8.GetBytes(json), out ProtocolMessage message, out RefusalCode code))
        {
            return string.Concat("refused:", ProtocolNames.Of(code));
        }

        return string.Concat("ok:", ProtocolNames.Of(message.Type));
    }

    // ---------------------------------------------------------- state machine

    private static void AddStateMachineVectors(List<ConformanceVector> vectors)
    {
        vectors.Add(Vector(
            "state/full-linear-sequence",
            "completed:cleanup-complete",
            RunSequence(
                SetupJson(),
                StateJson("setup-complete", 1),
                StateJson("target-created", 2),
                StateJson("target-suspended", 3),
                StateJson("target-ready", 4),
                StateJson("target-exited", 5),
                StateJson("cleanup-complete", 6))));
        vectors.Add(Vector(
            "state/duplicate-state",
            "refused:state-duplicate",
            RunSequence(
                SetupJson(),
                StateJson("setup-complete", 1),
                StateJson("setup-complete", 2))));
        vectors.Add(Vector(
            "state/skipped-state",
            "refused:state-out-of-order",
            RunSequence(SetupJson(), StateJson("target-created", 1))));
        vectors.Add(Vector(
            "state/backwards-state",
            "refused:state-out-of-order",
            RunSequence(
                SetupJson(),
                StateJson("setup-complete", 1),
                StateJson("target-created", 2),
                StateJson("setup-complete", 3))));
        vectors.Add(Vector(
            "state/replayed-sequence-number",
            "refused:state-out-of-order",
            RunSequence(
                SetupJson(),
                StateJson("setup-complete", 2),
                StateJson("target-created", 2))));
        vectors.Add(Vector(
            "state/token-mismatch",
            "refused:token-mismatch",
            RunSequence(SetupJson(), StateJson("setup-complete", 1, OtherToken))));
        vectors.Add(Vector(
            "state/duplicate-setup",
            "refused:setup-duplicate",
            RunSequence(SetupJson(), SetupJson())));
        vectors.Add(Vector(
            "state/report-before-setup",
            "refused:setup-missing",
            RunSequence(StateJson("setup-complete", 1))));
        vectors.Add(Vector(
            "state/frame-after-terminal",
            "refused:state-out-of-order",
            RunSequence(
                SetupJson(),
                StateJson("setup-complete", 1),
                StateJson("target-created", 2),
                StateJson("target-suspended", 3),
                StateJson("target-ready", 4),
                StateJson("target-exited", 5),
                StateJson("cleanup-complete", 6),
                StateJson("cleanup-complete", 7))));
        vectors.Add(Vector(
            "state/cancel-is-terminal",
            "cancelled:operation-cancelled",
            RunSequence(SetupJson(), StateJson("setup-complete", 1), CancelJson())));
        vectors.Add(Vector(
            "state/peer-refusal-is-terminal",
            "refused:deadline-exceeded",
            RunSequence(
                SetupJson(),
                Utf8.GetString(ProtocolMessage.SerializeRefusal(Token, RefusalCode.DeadlineExceeded)))));
        vectors.Add(Vector(
            "state/cancel-before-setup",
            "refused:setup-missing",
            RunSequence(CancelJson())));
    }

    private static string RunSequence(params string[] frames)
    {
        OperationStateMachine machine = new();
        TransitionResult result = new(TransitionOutcome.Accepted, OperationState.None, RefusalCode.None);
        foreach (string frame in frames)
        {
            if (!ProtocolMessage.TryParse(Utf8.GetBytes(frame), out ProtocolMessage message, out RefusalCode code))
            {
                return string.Concat("parse-refused:", ProtocolNames.Of(code));
            }

            result = machine.Offer(message);
            if (result.Outcome is TransitionOutcome.Refused or TransitionOutcome.Cancelled)
            {
                break;
            }
        }

        return result.Outcome switch
        {
            TransitionOutcome.Accepted => string.Concat("accepted:", ProtocolNames.Of(result.State)),
            TransitionOutcome.Completed => string.Concat("completed:", ProtocolNames.Of(result.State)),
            TransitionOutcome.Cancelled => string.Concat("cancelled:", ProtocolNames.Of(result.Refusal)),
            _ => string.Concat("refused:", ProtocolNames.Of(result.Refusal)),
        };
    }

    // -------------------------------------------------------- canonical JSON

    private static void AddCanonicalVectors(List<ConformanceVector> vectors)
    {
        CanonicalObject unordered = new CanonicalObject()
            .Set("zeta", 1)
            .Set("alpha", "a")
            .Set("mu", true);
        vectors.Add(Vector(
            "canonical/member-order-is-ordinal",
            "{\"alpha\":\"a\",\"mu\":true,\"zeta\":1}",
            CanonicalJson.SerializeToString(unordered)));

        CanonicalObject escapes = new CanonicalObject()
            .Set("text", "line\r\n\ttab \"quote\" back\\slash \u0001");
        vectors.Add(Vector(
            "canonical/minimal-escape-table",
            "{\"text\":\"line\\r\\n\\ttab \\\"quote\\\" back\\\\slash \\u0001\"}",
            CanonicalJson.SerializeToString(escapes)));

        CanonicalObject numbers = new CanonicalObject()
            .Set("negative", -9007199254740991)
            .Set("zero", 0);
        vectors.Add(Vector(
            "canonical/integers-only",
            "{\"negative\":-9007199254740991,\"zero\":0}",
            CanonicalJson.SerializeToString(numbers)));

        List<string> items = ["b", "a"];
        CanonicalObject arrays = new CanonicalObject().Set("items", items);
        vectors.Add(Vector(
            "canonical/array-order-preserved",
            "{\"items\":[\"b\",\"a\"]}",
            CanonicalJson.SerializeToString(arrays)));

        CanonicalObject reordered = new CanonicalObject()
            .Set("alpha", "a")
            .Set("mu", true)
            .Set("zeta", 1);
        vectors.Add(Vector(
            "canonical/insertion-order-independent",
            "true",
            string.Equals(
                CanonicalJson.SerializeToString(unordered),
                CanonicalJson.SerializeToString(reordered),
                StringComparison.Ordinal) ? "true" : "false"));
    }

    // ----------------------------------------------------------- derivation

    private static void AddTokenVectors(List<ConformanceVector> vectors)
    {
        vectors.Add(Vector(
            "token/profile-name-stable",
            "AiDevOs.S17.5d1d2919a5bc7d29ae6c908688e74ca7",
            TokenDerivation.ProfileName(Token)));
        vectors.Add(Vector(
            "token/staging-root-stable",
            "aidevos-s17-8e0a428992e9cd87c83d99caff6b2e7c",
            TokenDerivation.StagingRootLeaf(Token)));
        vectors.Add(Vector(
            "token/journal-file-name",
            Token + ".journal",
            TokenDerivation.JournalFileName(Token)));
        vectors.Add(Vector(
            "token/purposes-differ",
            "true",
            string.Equals(
                TokenDerivation.Derive("staging-root", Token),
                TokenDerivation.Derive("appcontainer-profile", Token),
                StringComparison.Ordinal) ? "false" : "true"));
        vectors.Add(Vector(
            "token/different-token-different-names",
            "true",
            string.Equals(
                TokenDerivation.ProfileName(Token),
                TokenDerivation.ProfileName(OtherToken),
                StringComparison.Ordinal) ? "false" : "true"));
        vectors.Add(Vector(
            "token/rejects-uppercase",
            "false",
            TokenDerivation.IsValidOperationToken("0123456789ABCDEF0123456789abcdef")
                ? "true"
                : "false"));
        vectors.Add(Vector(
            "token/rejects-wrong-length",
            "false",
            TokenDerivation.IsValidOperationToken("0123456789abcdef") ? "true" : "false"));
    }

    // ------------------------------------------------------------- recovery

    private static RecoveryRecord Record(OperationState phase, long sequence, string token = Token) =>
        new(FixtureComponent, token, phase, sequence, FixtureBundleVersion);

    private static byte[] Journal(params RecoveryRecord[] records)
    {
        List<byte> buffer = [];
        foreach (RecoveryRecord record in records)
        {
            buffer.AddRange(RecoveryRecordCodec.Frame(record));
        }

        return [.. buffer];
    }

    private static void AddRecoveryVectors(List<ConformanceVector> vectors)
    {
        RecoveryRecord first = Record(OperationState.RequestAccepted, 1);
        RecoveryRecord second = Record(OperationState.SetupComplete, 2);
        RecoveryRecord third = Record(OperationState.CleanupComplete, 3);

        vectors.Add(Vector(
            "recovery/canonical-record",
            "{\"bundleVersion\":\"1.0.0\",\"component\":\"windows-supervisor\"," +
            "\"operationToken\":\"" + Token + "\",\"phase\":\"request-accepted\"," +
            "\"profileName\":\"AiDevOs.S17.5d1d2919a5bc7d29ae6c908688e74ca7\"," +
            "\"recordVersion\":1,\"schemaVersion\":1,\"sequence\":1," +
            "\"stagedFileNames\":[\"req-12ece52677716308770858ddb48c8b97.bin\"," +
            "\"res-418567b7c99828864120f7bed2297b7a.bin\"]," +
            "\"stagingRootLeaf\":\"aidevos-s17-8e0a428992e9cd87c83d99caff6b2e7c\"}",
            Utf8.GetString(RecoveryRecordCodec.SerializeCanonical(first))));

        vectors.Add(Vector(
            "recovery/journal-roundtrip",
            "ok:2:complete",
            ReadJournal(Journal(first, second), Token)));
        vectors.Add(Vector(
            "recovery/truncated-trailing-record-discarded",
            "ok:2:truncated",
            ReadJournal(TruncateTail(Journal(first, second, third), 10), Token)));
        vectors.Add(Vector(
            "recovery/truncated-prefix-discarded",
            "ok:2:truncated",
            ReadJournal(AppendBytes(Journal(first, second), [0x01, 0x02]), Token)));
        vectors.Add(Vector(
            "recovery/digest-mismatch",
            "refused:recovery-record-digest-mismatch",
            ReadJournal(FlipLastByte(Journal(first)), Token)));
        vectors.Add(Vector(
            "recovery/token-substitution",
            "refused:recovery-record-token-mismatch",
            ReadJournal(Journal(Record(OperationState.RequestAccepted, 1, OtherToken)), Token)));
        vectors.Add(Vector(
            "recovery/sequence-replay",
            "refused:recovery-record-sequence-invalid",
            ReadJournal(
                Journal(first, Record(OperationState.SetupComplete, 1)),
                Token)));
        vectors.Add(Vector(
            "recovery/phase-regression",
            "refused:state-out-of-order",
            ReadJournal(
                Journal(second, Record(OperationState.RequestAccepted, 3)),
                Token)));
        vectors.Add(Vector(
            "recovery/path-substitution",
            "refused:recovery-record-path-mismatch",
            ReadJournal(SubstitutedPathJournal(), Token)));
        vectors.Add(Vector(
            "recovery/unknown-property",
            "refused:recovery-record-schema-invalid",
            ReadJournal(UnknownPropertyJournal(), Token)));
        vectors.Add(Vector(
            "recovery/oversized-declared-record",
            "refused:recovery-record-schema-invalid",
            ReadJournal(OversizedRecordJournal(), Token)));
        vectors.Add(Vector(
            "recovery/malformed-expected-token",
            "refused:token-malformed",
            ReadJournal(Journal(first), "not-a-token")));

        RecoveryJournal complete = ReadJournalObject(Journal(first, second, third), Token);
        RecoveryJournal partial = ReadJournalObject(Journal(first, second), Token);
        List<string> noLiveTokens = [];
        List<string> liveTokens = [Token];
        vectors.Add(Vector(
            "recovery/completed-journal-not-actionable",
            "false",
            RecoveryRecordCodec.IsActionable(Token, complete, noLiveTokens) ? "true" : "false"));
        vectors.Add(Vector(
            "recovery/partial-journal-actionable",
            "true",
            RecoveryRecordCodec.IsActionable(Token, partial, noLiveTokens) ? "true" : "false"));
        vectors.Add(Vector(
            "recovery/live-token-skipped",
            "false",
            RecoveryRecordCodec.IsActionable(Token, partial, liveTokens) ? "true" : "false"));
    }

    private static string ReadJournal(byte[] buffer, string token)
    {
        if (!RecoveryRecordCodec.TryRead(buffer, token, out RecoveryJournal journal, out RefusalCode code))
        {
            return string.Concat("refused:", ProtocolNames.Of(code));
        }

        return string.Concat(
            "ok:",
            journal.Records.Count.ToString(CultureInfo.InvariantCulture),
            journal.TruncatedTrailingRecordDiscarded ? ":truncated" : ":complete");
    }

    private static RecoveryJournal ReadJournalObject(byte[] buffer, string token) =>
        RecoveryRecordCodec.TryRead(buffer, token, out RecoveryJournal journal, out _)
            ? journal
            : new RecoveryJournal([], false);

    private static byte[] TruncateTail(byte[] buffer, int drop) => buffer[..^drop];

    private static byte[] AppendBytes(byte[] buffer, byte[] extra)
    {
        byte[] combined = new byte[buffer.Length + extra.Length];
        buffer.CopyTo(combined, 0);
        extra.CopyTo(combined, buffer.Length);
        return combined;
    }

    private static byte[] FlipLastByte(byte[] buffer)
    {
        byte[] copy = (byte[])buffer.Clone();
        copy[^1] ^= 0xFF;
        return copy;
    }

    private static byte[] FramedCanonical(string canonical)
    {
        byte[] bytes = Utf8.GetBytes(canonical);
        byte[] digest = RecoveryRecordCodec.Digest(bytes);
        List<byte> buffer =
        [
            (byte)(bytes.Length & 0xFF),
            (byte)((bytes.Length >> 8) & 0xFF),
            (byte)((bytes.Length >> 16) & 0xFF),
            (byte)((bytes.Length >> 24) & 0xFF),
        ];
        buffer.AddRange(bytes);
        buffer.AddRange(digest);
        return [.. buffer];
    }

    private static byte[] SubstitutedPathJournal() =>
        FramedCanonical(
            "{\"bundleVersion\":\"1.0.0\",\"component\":\"windows-supervisor\"," +
            "\"operationToken\":\"" + Token + "\",\"phase\":\"request-accepted\"," +
            "\"profileName\":\"AiDevOs.S17.00000000000000000000000000000000\"," +
            "\"recordVersion\":1,\"schemaVersion\":1,\"sequence\":1," +
            "\"stagedFileNames\":[\"req-12ece52677716308770858ddb48c8b97.bin\"," +
            "\"res-418567b7c99828864120f7bed2297b7a.bin\"]," +
            "\"stagingRootLeaf\":\"aidevos-s17-8e0a428992e9cd87c83d99caff6b2e7c\"}");

    private static byte[] UnknownPropertyJournal() =>
        FramedCanonical(
            "{\"bundleVersion\":\"1.0.0\",\"component\":\"windows-supervisor\"," +
            "\"extra\":1,\"operationToken\":\"" + Token + "\",\"phase\":\"request-accepted\"," +
            "\"profileName\":\"AiDevOs.S17.5d1d2919a5bc7d29ae6c908688e74ca7\"," +
            "\"recordVersion\":1,\"schemaVersion\":1,\"sequence\":1," +
            "\"stagedFileNames\":[\"req-12ece52677716308770858ddb48c8b97.bin\"," +
            "\"res-418567b7c99828864120f7bed2297b7a.bin\"]," +
            "\"stagingRootLeaf\":\"aidevos-s17-8e0a428992e9cd87c83d99caff6b2e7c\"}");

    private static byte[] OversizedRecordJournal()
    {
        List<byte> buffer =
        [
            0x01,
            0x00,
            0x01,
            0x00,
        ];
        return [.. buffer];
    }

    // ------------------------------------------------------------- manifest

    private const string ManifestJson =
        "{\"schemaVersion\":1," +
        "\"manifestKind\":\"ai-dev-os-windows-production-artifact-manifest\"," +
        "\"component\":\"windows-supervisor\"," +
        "\"protocolVersion\":1," +
        "\"sourceVersion\":\"1.0.0\"," +
        "\"buildRecipeVersion\":1," +
        "\"platform\":\"win32\"," +
        "\"rid\":\"win-x64\"," +
        "\"architecture\":\"x64\"," +
        "\"packageVersion\":\"0.1.0\"," +
        "\"bundleVersion\":\"1.0.0\"," +
        "\"fileCount\":2," +
        "\"totalBytes\":7," +
        "\"files\":[" +
        "{\"name\":\"alpha.dll\",\"size\":3," +
        "\"sha256\":\"a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3\"}," +
        "{\"name\":\"beta.exe\",\"size\":4," +
        "\"sha256\":\"03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4\"}]," +
        "\"sourceEnvelopeFingerprint\":" +
        "\"1111111111111111111111111111111111111111111111111111111111111111\"," +
        "\"buildManifestFingerprint\":" +
        "\"2222222222222222222222222222222222222222222222222222222222222222\"," +
        "\"corpusVersion\":1," +
        "\"corpusFingerprint\":" +
        "\"125b809194d26cf1be518249b96727b78be80c25088826464ec94154a6fb3652\"," +
        "\"windowsApplicableVectorCount\":40," +
        "\"signerState\":\"unsigned-candidate\"," +
        "\"productionEligible\":false," +
        "\"limitations\":[\"artifact-never-executed\",\"unsigned-candidate\"]}";

    internal static string ManifestFixtureJson => ManifestJson;

    private static void AddManifestVectors(List<ConformanceVector> vectors)
    {
        vectors.Add(Vector("manifest/parse-valid", "ok:2", ParseManifest(ManifestJson)));
        vectors.Add(Vector(
            "manifest/fingerprint-stable",
            ManifestFixtureFingerprint(),
            ManifestFixtureFingerprint()));
        vectors.Add(Vector(
            "manifest/unknown-field",
            "refused:manifest-schema-invalid",
            ParseManifest(ManifestJson.Replace(
                "\"schemaVersion\":1,",
                "\"schemaVersion\":1,\"surprise\":1,",
                StringComparison.Ordinal))));
        vectors.Add(Vector(
            "manifest/wrong-kind",
            "refused:manifest-schema-invalid",
            ParseManifest(ManifestJson.Replace(
                "ai-dev-os-windows-production-artifact-manifest",
                "ai-dev-os-windows-feasibility-probe",
                StringComparison.Ordinal))));
        vectors.Add(Vector(
            "manifest/duplicate-file",
            "refused:manifest-file-duplicate",
            ParseManifest(ManifestJson.Replace(
                "{\"name\":\"beta.exe\",\"size\":4",
                "{\"name\":\"alpha.dll\",\"size\":4",
                StringComparison.Ordinal))));
        vectors.Add(Vector(
            "manifest/case-only-duplicate-file",
            "refused:manifest-file-duplicate",
            ParseManifest(ManifestJson.Replace(
                "{\"name\":\"beta.exe\",\"size\":4",
                "{\"name\":\"ALPHA.dll\",\"size\":4",
                StringComparison.Ordinal))));
        vectors.Add(Vector(
            "manifest/unsorted-files",
            "refused:manifest-schema-invalid",
            ParseManifest(SwapFixtureFileOrder())));
        vectors.Add(Vector(
            "manifest/path-separator-in-name",
            "refused:manifest-file-name-invalid",
            ParseManifest(ManifestJson.Replace(
                "\"name\":\"alpha.dll\"",
                "\"name\":\"sub/alpha.dll\"",
                StringComparison.Ordinal))));
        vectors.Add(Vector(
            "manifest/dot-segment-in-name",
            "refused:manifest-file-name-invalid",
            ParseManifest(ManifestJson.Replace(
                "\"name\":\"alpha.dll\"",
                "\"name\":\"a..dll\"",
                StringComparison.Ordinal))));
        vectors.Add(Vector(
            "manifest/reserved-device-name",
            "refused:manifest-file-name-invalid",
            ParseManifest(ManifestJson.Replace(
                "\"name\":\"alpha.dll\"",
                "\"name\":\"NUL.dll\"",
                StringComparison.Ordinal))));
        vectors.Add(Vector(
            "manifest/non-ascii-name",
            "refused:manifest-file-name-invalid",
            ParseManifest(ManifestJson.Replace(
                "\"name\":\"alpha.dll\"",
                "\"name\":\"alph\u00e1.dll\"",
                StringComparison.Ordinal))));
        vectors.Add(Vector(
            "manifest/file-count-mismatch",
            "refused:manifest-schema-invalid",
            ParseManifest(ManifestJson.Replace(
                "\"fileCount\":2",
                "\"fileCount\":3",
                StringComparison.Ordinal))));
        vectors.Add(Vector(
            "manifest/total-bytes-mismatch",
            "refused:manifest-schema-invalid",
            ParseManifest(ManifestJson.Replace(
                "\"totalBytes\":7",
                "\"totalBytes\":8",
                StringComparison.Ordinal))));
        vectors.Add(Vector(
            "manifest/unsorted-limitations",
            "refused:manifest-schema-invalid",
            ParseManifest(ManifestJson.Replace(
                "[\"artifact-never-executed\",\"unsigned-candidate\"]",
                "[\"unsigned-candidate\",\"artifact-never-executed\"]",
                StringComparison.Ordinal))));
        vectors.Add(Vector(
            "manifest/closure-verified",
            "none",
            VerifyClosure(ClosureSource())));
        vectors.Add(Vector(
            "manifest/closure-missing-file",
            "manifest-file-missing",
            VerifyClosure(new InMemoryArtifactFileSource().Add("alpha.dll", Utf8.GetBytes("123")))));
        vectors.Add(Vector(
            "manifest/closure-unexpected-file",
            "manifest-file-unexpected",
            VerifyClosure(ClosureSource().Add("gamma.dll", Utf8.GetBytes("x")))));
        vectors.Add(Vector(
            "manifest/closure-size-mismatch",
            "manifest-file-size-mismatch",
            VerifyClosure(new InMemoryArtifactFileSource()
                .Add("alpha.dll", Utf8.GetBytes("1234"))
                .Add("beta.exe", Utf8.GetBytes("1234")))));
        vectors.Add(Vector(
            "manifest/closure-digest-mismatch",
            "manifest-file-digest-mismatch",
            VerifyClosure(new InMemoryArtifactFileSource()
                .Add("alpha.dll", Utf8.GetBytes("xyz"))
                .Add("beta.exe", Utf8.GetBytes("1234")))));
    }

    private static InMemoryArtifactFileSource ClosureSource() =>
        new InMemoryArtifactFileSource()
            .Add("alpha.dll", Utf8.GetBytes("123"))
            .Add("beta.exe", Utf8.GetBytes("1234"));

    private static string SwapFixtureFileOrder()
    {
        const string alpha = "{\"name\":\"alpha.dll\",\"size\":3," +
            "\"sha256\":\"a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3\"}";
        const string beta = "{\"name\":\"beta.exe\",\"size\":4," +
            "\"sha256\":\"03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4\"}";
        return ManifestJson.Replace(
            string.Concat(alpha, ",", beta),
            string.Concat(beta, ",", alpha),
            StringComparison.Ordinal);
    }

    private static string ParseManifest(string json)
    {
        if (!ArtifactManifestReader.TryParse(Utf8.GetBytes(json), out ArtifactManifest manifest, out RefusalCode code))
        {
            return string.Concat("refused:", ProtocolNames.Of(code));
        }

        return string.Concat("ok:", manifest.Files.Count.ToString(CultureInfo.InvariantCulture));
    }

    private static string VerifyClosure(IArtifactFileSource source)
    {
        if (!ArtifactManifestReader.TryParse(Utf8.GetBytes(ManifestJson), out ArtifactManifest manifest, out RefusalCode code))
        {
            return string.Concat("parse:", ProtocolNames.Of(code));
        }

        return ProtocolNames.Of(ArtifactManifestVerifier.VerifyClosure(manifest, source));
    }

    /// <summary>
    /// The fingerprint of the fixed embedded manifest fixture. The TypeScript
    /// control plane computes the same value from the same fixture; the
    /// packaging pipeline compares them so the two implementations of canonical
    /// manifest identity cannot drift apart silently.
    /// </summary>
    internal static string ManifestFixtureFingerprint()
    {
        if (!ArtifactManifestReader.TryParse(Utf8.GetBytes(ManifestJson), out ArtifactManifest manifest, out _))
        {
            return new string('0', ProtocolContract.FingerprintHexLength);
        }

        return manifest.Fingerprint();
    }

    internal static string Sha256Hex(string text) =>
        ArtifactManifest.Sha256Hex(SHA256.HashData(Utf8.GetBytes(text)));

    private static ConformanceVector Vector(string name, string expected, string observed) =>
        new(name, expected, observed);
}

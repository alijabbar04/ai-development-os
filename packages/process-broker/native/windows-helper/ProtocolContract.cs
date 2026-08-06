using System;
using System.Collections.Generic;

namespace AiDevOs.WindowsHelper;

/// <summary>
/// Fixed limits and closed enumerations of Windows production protocol
/// version 1 (ADR 0017 section 4). Every bound here is a constant: none of
/// them is configurable, negotiable, or reachable from a protocol field.
/// </summary>
internal static class ProtocolContract
{
    internal const int ProtocolVersion = 1;
    internal const int SchemaVersion = 1;

    // Section 4.1 framing bounds.
    internal const int FrameLengthPrefixBytes = 4;
    internal const int MaxFramePayloadBytes = 8_192;
    internal const int MaxConnectionBytes = 262_144;
    internal const int MaxFramesPerConnection = 32;

    // Section 4.2 parsing bounds.
    internal const int MaxJsonDepth = 5;
    internal const int MaxObjectMembers = 24;
    internal const int MaxStringLength = 256;
    internal const int MaxStringArrayLength = 16;
    internal const int OperationTokenHexLength = 32;
    internal const int FingerprintHexLength = 64;
    internal const int MaxBundleVersionLength = 40;
    internal const long MinSequence = 1;
    internal const long MaxSequence = MaxFramesPerConnection;

    // Section 5 recovery-record bounds.
    internal const int MaxRecoveryRecordBytes = 4_096;
    internal const int MaxRecoveryRecordsPerJournal = 16;
    internal const int RecoveryDigestBytes = 32;
    internal const int DerivedNameHexLength = 32;

    // Section 6 artifact-manifest bounds.
    internal const int MaxManifestBytes = 1_048_576;
    internal const int MaxManifestObjectMembers = 32;
    internal const int MaxManifestFileCount = 1_024;
    internal const int MaxManifestFileNameLength = 128;
    internal const long MaxManifestFileBytes = 268_435_456L;
}

/// <summary>Linear, monotonic operation states (ADR 0017 section 4.3).</summary>
internal enum OperationState
{
    /// <summary>No setup frame has been accepted yet.</summary>
    None = 0,
    RequestAccepted = 1,
    SetupComplete = 2,
    TargetCreated = 3,
    TargetSuspended = 4,
    TargetReady = 5,
    TargetExited = 6,
    CleanupComplete = 7,
}

/// <summary>The closed set of protocol message types.</summary>
internal enum ProtocolMessageType
{
    SetupRequest = 1,
    StateReport = 2,
    Cancel = 3,
    Refusal = 4,
}

/// <summary>
/// The closed refusal enumeration. Every failure the components can report is
/// one of these codes and carries no body: no path, no user name, no argument,
/// no exception text, and no offending value.
/// </summary>
internal enum RefusalCode
{
    None = 0,
    FrameTruncated,
    FrameTooLarge,
    FrameEmpty,
    FrameCountExceeded,
    ConnectionBytesExceeded,
    InvalidUtf8,
    InvalidJson,
    JsonDepthExceeded,
    UnknownProperty,
    DuplicateProperty,
    MissingProperty,
    ForbiddenPropertyName,
    TypeMismatch,
    ValueOutOfRange,
    UnknownMessageType,
    ProtocolVersionMismatch,
    SchemaVersionMismatch,
    TokenMalformed,
    TokenMismatch,
    SetupDuplicate,
    SetupMissing,
    StateUnknown,
    StateDuplicate,
    StateOutOfOrder,
    OperationCancelled,
    DeadlineExceeded,
    RecoveryRecordTruncated,
    RecoveryRecordDigestMismatch,
    RecoveryRecordSchemaInvalid,
    RecoveryRecordPathMismatch,
    RecoveryRecordSequenceInvalid,
    RecoveryRecordTokenMismatch,
    RecoveryJournalOverlong,
    ManifestSchemaInvalid,
    ManifestIdentityMismatch,
    ManifestFileMissing,
    ManifestFileUnexpected,
    ManifestFileDuplicate,
    ManifestFileSizeMismatch,
    ManifestFileDigestMismatch,
    ManifestFileNameInvalid,
    ManifestTooLarge,

    // Ownership-bearing closure verification (ADR 0017 section 6.5 steps 3-5).
    ClosureLeaseNotHeld,
    ClosureLeaseIncomplete,
    ClosureHandleClosed,
    ClosureHandleUnavailable,
    ClosureShareModePermitsWrite,
    ClosureShareModePermitsDelete,
    ClosureMeasurementNotThroughHandle,
    ClosureImageNotVerified,
    ClosureRootNotBound,
    ChildIdentityMismatch,

    // Bundle path resolution (ADR 0017 section 6.5 step 1).
    ArtifactPathReparsePoint,
    ArtifactPathEscape,
    ArtifactPathNormalizationAmbiguous,
    ArtifactRootUnresolvable,

    // Stable Win32-error classes. The underlying numeric error is never
    // echoed: a refusal carries a class, not an operating-system detail.
    NativeAccessDenied,
    NativeInvalidHandle,
    NativeAlreadyExists,
    NativeNotFound,
    NativeResourceExhausted,
    NativeNotSupported,
    NativeUnexpectedFailure,

    // Journal durability and exactness (ADR 0017 section 5).
    RecoveryJournalAlreadyExists,
    RecoveryJournalWriteFailed,
    RecoveryJournalDurabilityUnavailable,
    RecoveryDeletionOutsideDerivedSet,

    EnvironmentBlockInvalid,
    ProofModeNotAuthorized,
    MutatingOperationsUnauthorized,

    ArgumentInvalid,
    UnknownCommand,
    MutatingOperationsStructurallyDisabled,
    InternalRefusal,
}

/// <summary>Wire spellings for the closed enumerations above.</summary>
internal static class ProtocolNames
{
    private static readonly Dictionary<OperationState, string> StateNames = new()
        {
            [OperationState.None] = "none",
            [OperationState.RequestAccepted] = "request-accepted",
            [OperationState.SetupComplete] = "setup-complete",
            [OperationState.TargetCreated] = "target-created",
            [OperationState.TargetSuspended] = "target-suspended",
            [OperationState.TargetReady] = "target-ready",
            [OperationState.TargetExited] = "target-exited",
            [OperationState.CleanupComplete] = "cleanup-complete",
        };

    private static readonly Dictionary<string, OperationState> StateValues = BuildStateValues();

    private static readonly Dictionary<ProtocolMessageType, string> MessageTypeNames = new()
        {
            [ProtocolMessageType.SetupRequest] = "setup-request",
            [ProtocolMessageType.StateReport] = "state-report",
            [ProtocolMessageType.Cancel] = "cancel",
            [ProtocolMessageType.Refusal] = "refusal",
        };

    private static readonly Dictionary<RefusalCode, string> RefusalNames = new()
        {
            [RefusalCode.None] = "none",
            [RefusalCode.FrameTruncated] = "frame-truncated",
            [RefusalCode.FrameTooLarge] = "frame-too-large",
            [RefusalCode.FrameEmpty] = "frame-empty",
            [RefusalCode.FrameCountExceeded] = "frame-count-exceeded",
            [RefusalCode.ConnectionBytesExceeded] = "connection-bytes-exceeded",
            [RefusalCode.InvalidUtf8] = "invalid-utf8",
            [RefusalCode.InvalidJson] = "invalid-json",
            [RefusalCode.JsonDepthExceeded] = "json-depth-exceeded",
            [RefusalCode.UnknownProperty] = "unknown-property",
            [RefusalCode.DuplicateProperty] = "duplicate-property",
            [RefusalCode.MissingProperty] = "missing-property",
            [RefusalCode.ForbiddenPropertyName] = "forbidden-property-name",
            [RefusalCode.TypeMismatch] = "type-mismatch",
            [RefusalCode.ValueOutOfRange] = "value-out-of-range",
            [RefusalCode.UnknownMessageType] = "unknown-message-type",
            [RefusalCode.ProtocolVersionMismatch] = "protocol-version-mismatch",
            [RefusalCode.SchemaVersionMismatch] = "schema-version-mismatch",
            [RefusalCode.TokenMalformed] = "token-malformed",
            [RefusalCode.TokenMismatch] = "token-mismatch",
            [RefusalCode.SetupDuplicate] = "setup-duplicate",
            [RefusalCode.SetupMissing] = "setup-missing",
            [RefusalCode.StateUnknown] = "state-unknown",
            [RefusalCode.StateDuplicate] = "state-duplicate",
            [RefusalCode.StateOutOfOrder] = "state-out-of-order",
            [RefusalCode.OperationCancelled] = "operation-cancelled",
            [RefusalCode.DeadlineExceeded] = "deadline-exceeded",
            [RefusalCode.RecoveryRecordTruncated] = "recovery-record-truncated",
            [RefusalCode.RecoveryRecordDigestMismatch] = "recovery-record-digest-mismatch",
            [RefusalCode.RecoveryRecordSchemaInvalid] = "recovery-record-schema-invalid",
            [RefusalCode.RecoveryRecordPathMismatch] = "recovery-record-path-mismatch",
            [RefusalCode.RecoveryRecordSequenceInvalid] = "recovery-record-sequence-invalid",
            [RefusalCode.RecoveryRecordTokenMismatch] = "recovery-record-token-mismatch",
            [RefusalCode.RecoveryJournalOverlong] = "recovery-journal-overlong",
            [RefusalCode.ManifestSchemaInvalid] = "manifest-schema-invalid",
            [RefusalCode.ManifestIdentityMismatch] = "manifest-identity-mismatch",
            [RefusalCode.ManifestFileMissing] = "manifest-file-missing",
            [RefusalCode.ManifestFileUnexpected] = "manifest-file-unexpected",
            [RefusalCode.ManifestFileDuplicate] = "manifest-file-duplicate",
            [RefusalCode.ManifestFileSizeMismatch] = "manifest-file-size-mismatch",
            [RefusalCode.ManifestFileDigestMismatch] = "manifest-file-digest-mismatch",
            [RefusalCode.ManifestFileNameInvalid] = "manifest-file-name-invalid",
            [RefusalCode.ManifestTooLarge] = "manifest-too-large",
            [RefusalCode.ClosureLeaseNotHeld] = "closure-lease-not-held",
            [RefusalCode.ClosureLeaseIncomplete] = "closure-lease-incomplete",
            [RefusalCode.ClosureHandleClosed] = "closure-handle-closed",
            [RefusalCode.ClosureHandleUnavailable] = "closure-handle-unavailable",
            [RefusalCode.ClosureShareModePermitsWrite] = "closure-share-mode-permits-write",
            [RefusalCode.ClosureShareModePermitsDelete] = "closure-share-mode-permits-delete",
            [RefusalCode.ClosureMeasurementNotThroughHandle] =
                "closure-measurement-not-through-handle",
            [RefusalCode.ClosureImageNotVerified] = "closure-image-not-verified",
            [RefusalCode.ClosureRootNotBound] = "closure-root-not-bound",
            [RefusalCode.ChildIdentityMismatch] = "child-identity-mismatch",
            [RefusalCode.ArtifactPathReparsePoint] = "artifact-path-reparse-point",
            [RefusalCode.ArtifactPathEscape] = "artifact-path-escape",
            [RefusalCode.ArtifactPathNormalizationAmbiguous] =
                "artifact-path-normalization-ambiguous",
            [RefusalCode.ArtifactRootUnresolvable] = "artifact-root-unresolvable",
            [RefusalCode.NativeAccessDenied] = "native-access-denied",
            [RefusalCode.NativeInvalidHandle] = "native-invalid-handle",
            [RefusalCode.NativeAlreadyExists] = "native-already-exists",
            [RefusalCode.NativeNotFound] = "native-not-found",
            [RefusalCode.NativeResourceExhausted] = "native-resource-exhausted",
            [RefusalCode.NativeNotSupported] = "native-not-supported",
            [RefusalCode.NativeUnexpectedFailure] = "native-unexpected-failure",
            [RefusalCode.RecoveryJournalAlreadyExists] = "recovery-journal-already-exists",
            [RefusalCode.RecoveryJournalWriteFailed] = "recovery-journal-write-failed",
            [RefusalCode.RecoveryJournalDurabilityUnavailable] =
                "recovery-journal-durability-unavailable",
            [RefusalCode.RecoveryDeletionOutsideDerivedSet] =
                "recovery-deletion-outside-derived-set",
            [RefusalCode.EnvironmentBlockInvalid] = "environment-block-invalid",
            [RefusalCode.ProofModeNotAuthorized] = "proof-mode-not-authorized",
            [RefusalCode.MutatingOperationsUnauthorized] = "mutating-operations-unauthorized",
            [RefusalCode.ArgumentInvalid] = "argument-invalid",
            [RefusalCode.UnknownCommand] = "unknown-command",
            [RefusalCode.MutatingOperationsStructurallyDisabled] =
                "mutating-operations-structurally-disabled",
            [RefusalCode.InternalRefusal] = "internal-refusal",
        };

    private static Dictionary<string, OperationState> BuildStateValues()
    {
        Dictionary<string, OperationState> values = new(StringComparer.Ordinal);
        foreach (KeyValuePair<OperationState, string> entry in StateNames)
        {
            if (entry.Key != OperationState.None)
            {
                values[entry.Value] = entry.Key;
            }
        }

        return values;
    }

    internal static string Of(OperationState state) =>
        StateNames.TryGetValue(state, out string? name) ? name : "none";

    internal static string Of(ProtocolMessageType type) =>
        MessageTypeNames.TryGetValue(type, out string? name) ? name : "unknown";

    internal static string Of(RefusalCode code) =>
        RefusalNames.TryGetValue(code, out string? name) ? name : "internal-refusal";

    internal static bool TryParseState(string text, out OperationState state) =>
        StateValues.TryGetValue(text, out state);

    internal static bool TryParseMessageType(string text, out ProtocolMessageType type)
    {
        foreach (KeyValuePair<ProtocolMessageType, string> entry in MessageTypeNames)
        {
            if (string.Equals(entry.Value, text, StringComparison.Ordinal))
            {
                type = entry.Key;
                return true;
            }
        }

        type = default;
        return false;
    }
}

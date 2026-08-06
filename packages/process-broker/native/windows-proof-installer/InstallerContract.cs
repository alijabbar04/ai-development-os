using System;
using System.Collections.Generic;

namespace AiDevOs.WindowsProofInstaller;

/// <summary>
/// The proof installer's own fixed identity. Every value is a compile-time
/// constant baked into reviewed source: none is read from the environment, the
/// command line, a configuration file, the registry, or a manifest.
/// </summary>
internal static class ComponentIdentity
{
    internal const string ComponentName = "windows-proof-installer";
    internal const string Role = "proof-installer";
    internal const string SourceVersion = "1.0.0";
    internal const int BuildRecipeVersion = 1;
    internal const string RuntimeIdentifier = "win-x64";
    internal const string Platform = "win32";
    internal const string Architecture = "x64";
    internal const string SignerState = "unsigned-candidate";

    /// <summary>
    /// Recorded in every output so no consumer can mistake this component for a
    /// production candidate. ADR 0018 section 2 excludes it from the npm
    /// package and from every production discovery path; this is the same fact
    /// stated in the binary's own words.
    /// </summary>
    internal const bool ProductionEligible = false;

    internal const string PurposeCode = "proof-only-handle-relative-installer";
}

/// <summary>
/// The closed refusal enumeration.
///
/// Every failure this component can report is one of these codes and carries no
/// body: no path, no user name, no SID, no argument, no exception text, no
/// NTSTATUS, and no Win32 error number. A refusal names a class of outcome, not
/// an operating-system detail, so a refusal can never be used to read back
/// information about a filesystem the caller could not otherwise see.
/// </summary>
internal enum RefusalCode
{
    None = 0,

    // ------------------------------------------------------ command surface
    UnknownCommand,
    ArgumentInvalid,
    ArgumentMissing,
    ArgumentRepeated,
    InternalRefusal,

    // ------------------------------------------------------------ mutation gate
    MutatingOperationsUnauthorized,
    ProofModeNotAuthorized,
    MutatingOperationsStructurallyDisabled,

    // --------------------------------------------------------- token and plan
    TokenMalformed,
    CandidateUnknown,
    CandidateAmbiguous,
    PlanNotDerivable,

    // ------------------------------------------- known folder and volume root
    KnownFolderUnresolvable,
    KnownFolderPathNotDriveRooted,
    KnownFolderPathNotCanonical,
    VolumeRootUnopenable,
    VolumeIdentityMismatch,
    VolumeFilesystemUnsupported,

    // ------------------------------------------------- handle-relative walk
    ComponentNameInvalid,
    ComponentUnopenable,
    ComponentNotDirectory,
    ComponentIsReparsePoint,
    ComponentFinalPathMismatch,
    ComponentIdentityMismatch,
    ComponentVolumeMismatch,
    AncestorHandleNotRetained,
    AncestorSharingPermitsDelete,
    RootDirectoryHandleNotSupplied,
    PathUsedWithoutHandle,

    // --------------------------------------------------- security descriptors
    SecurityDescriptorUnavailable,
    SecurityDescriptorCompositionFailed,
    SecurityDescriptorNotSuppliedAtCreation,
    OwnerUntrusted,
    DaclInheritanceNotBlocked,
    DaclUnexpectedAce,
    DaclMissingRequiredAce,
    ProofIdentityUnacceptable,
    StandardTokenUnavailable,
    AccessCheckUnavailable,
    ProofIdentityHoldsWrite,
    ProofIdentityHoldsDelete,
    ProofIdentityHoldsDeleteChild,
    ProofIdentityHoldsDaclChange,
    ProofIdentityHoldsOwnerChange,
    ProofIdentityLacksReadExecute,

    // ------------------------------------------------------------- creation
    CreateDispositionNotCreateOnly,
    CreateCollision,
    CreateFailed,
    ExistingComponentNotRepaired,

    // -------------------------------------------------------- source closure
    SourceRootUnopenable,
    SourceRootIsReparsePoint,
    SourceSharingPermitsWrite,
    SourceFileNameInvalid,
    SourceFileMissing,
    SourceFileUnexpected,
    SourceFileDuplicateCaseInsensitive,
    SourceFileSizeMismatch,
    SourceFileDigestMismatch,
    SourceManifestUnreadable,
    SourceManifestSchemaInvalid,
    SourceManifestFingerprintUnknown,
    SourceMeasurementNotThroughHandle,

    // --------------------------------------------------- destination closure
    DestinationExtraEntry,
    DestinationFileCollision,
    DestinationDigestMismatchAfterWrite,
    InstalledVersionExists,

    // -------------------------------------------------------------- removal
    RemovalTokenMismatch,
    RemovalUnexpectedEntry,
    RemovalDirectoryNotEmpty,
    RemovalManifestOrderViolation,
    RemovalRecordUnreadable,
    RemovalRecordSchemaInvalid,
    RemovalAncestorNotCreatedByThisTransaction,
    RemovalProtectedRootRefused,
    RemovalWildcardRefused,
    DeleteUnsupported,
    DeleteFailed,

    // ---------------------------------------------- stable native error classes
    NativeAccessDenied,
    NativeInvalidHandle,
    NativeAlreadyExists,
    NativeNotFound,
    NativeSharingViolation,
    NativeReparsePointEncountered,
    NativeObjectPathInvalid,
    NativeNotSupported,
    NativeResourceExhausted,
    NativeChangedUnderneath,
    NativeUnexpectedFailure,
}

/// <summary>Wire spellings for <see cref="RefusalCode"/>.</summary>
internal static class ProtocolNames
{
    private static readonly Dictionary<RefusalCode, string> RefusalNames = new()
        {
            [RefusalCode.None] = "none",
            [RefusalCode.UnknownCommand] = "unknown-command",
            [RefusalCode.ArgumentInvalid] = "argument-invalid",
            [RefusalCode.ArgumentMissing] = "argument-missing",
            [RefusalCode.ArgumentRepeated] = "argument-repeated",
            [RefusalCode.InternalRefusal] = "internal-refusal",
            [RefusalCode.MutatingOperationsUnauthorized] = "mutating-operations-unauthorized",
            [RefusalCode.ProofModeNotAuthorized] = "proof-mode-not-authorized",
            [RefusalCode.MutatingOperationsStructurallyDisabled] =
                "mutating-operations-structurally-disabled",
            [RefusalCode.TokenMalformed] = "token-malformed",
            [RefusalCode.CandidateUnknown] = "candidate-unknown",
            [RefusalCode.CandidateAmbiguous] = "candidate-ambiguous",
            [RefusalCode.PlanNotDerivable] = "plan-not-derivable",
            [RefusalCode.KnownFolderUnresolvable] = "known-folder-unresolvable",
            [RefusalCode.KnownFolderPathNotDriveRooted] = "known-folder-path-not-drive-rooted",
            [RefusalCode.KnownFolderPathNotCanonical] = "known-folder-path-not-canonical",
            [RefusalCode.VolumeRootUnopenable] = "volume-root-unopenable",
            [RefusalCode.VolumeIdentityMismatch] = "volume-identity-mismatch",
            [RefusalCode.VolumeFilesystemUnsupported] = "volume-filesystem-unsupported",
            [RefusalCode.ComponentNameInvalid] = "component-name-invalid",
            [RefusalCode.ComponentUnopenable] = "component-unopenable",
            [RefusalCode.ComponentNotDirectory] = "component-not-directory",
            [RefusalCode.ComponentIsReparsePoint] = "component-is-reparse-point",
            [RefusalCode.ComponentFinalPathMismatch] = "component-final-path-mismatch",
            [RefusalCode.ComponentIdentityMismatch] = "component-identity-mismatch",
            [RefusalCode.ComponentVolumeMismatch] = "component-volume-mismatch",
            [RefusalCode.AncestorHandleNotRetained] = "ancestor-handle-not-retained",
            [RefusalCode.AncestorSharingPermitsDelete] = "ancestor-sharing-permits-delete",
            [RefusalCode.RootDirectoryHandleNotSupplied] = "root-directory-handle-not-supplied",
            [RefusalCode.PathUsedWithoutHandle] = "path-used-without-handle",
            [RefusalCode.SecurityDescriptorUnavailable] = "security-descriptor-unavailable",
            [RefusalCode.SecurityDescriptorCompositionFailed] =
                "security-descriptor-composition-failed",
            [RefusalCode.SecurityDescriptorNotSuppliedAtCreation] =
                "security-descriptor-not-supplied-at-creation",
            [RefusalCode.OwnerUntrusted] = "owner-untrusted",
            [RefusalCode.DaclInheritanceNotBlocked] = "dacl-inheritance-not-blocked",
            [RefusalCode.DaclUnexpectedAce] = "dacl-unexpected-ace",
            [RefusalCode.DaclMissingRequiredAce] = "dacl-missing-required-ace",
            [RefusalCode.ProofIdentityUnacceptable] = "proof-identity-unacceptable",
            [RefusalCode.StandardTokenUnavailable] = "standard-token-unavailable",
            [RefusalCode.AccessCheckUnavailable] = "access-check-unavailable",
            [RefusalCode.ProofIdentityHoldsWrite] = "proof-identity-holds-write",
            [RefusalCode.ProofIdentityHoldsDelete] = "proof-identity-holds-delete",
            [RefusalCode.ProofIdentityHoldsDeleteChild] = "proof-identity-holds-delete-child",
            [RefusalCode.ProofIdentityHoldsDaclChange] = "proof-identity-holds-dacl-change",
            [RefusalCode.ProofIdentityHoldsOwnerChange] = "proof-identity-holds-owner-change",
            [RefusalCode.ProofIdentityLacksReadExecute] = "proof-identity-lacks-read-execute",
            [RefusalCode.CreateDispositionNotCreateOnly] = "create-disposition-not-create-only",
            [RefusalCode.CreateCollision] = "create-collision",
            [RefusalCode.CreateFailed] = "create-failed",
            [RefusalCode.ExistingComponentNotRepaired] = "existing-component-not-repaired",
            [RefusalCode.SourceRootUnopenable] = "source-root-unopenable",
            [RefusalCode.SourceRootIsReparsePoint] = "source-root-is-reparse-point",
            [RefusalCode.SourceSharingPermitsWrite] = "source-sharing-permits-write",
            [RefusalCode.SourceFileNameInvalid] = "source-file-name-invalid",
            [RefusalCode.SourceFileMissing] = "source-file-missing",
            [RefusalCode.SourceFileUnexpected] = "source-file-unexpected",
            [RefusalCode.SourceFileDuplicateCaseInsensitive] =
                "source-file-duplicate-case-insensitive",
            [RefusalCode.SourceFileSizeMismatch] = "source-file-size-mismatch",
            [RefusalCode.SourceFileDigestMismatch] = "source-file-digest-mismatch",
            [RefusalCode.SourceManifestUnreadable] = "source-manifest-unreadable",
            [RefusalCode.SourceManifestSchemaInvalid] = "source-manifest-schema-invalid",
            [RefusalCode.SourceManifestFingerprintUnknown] = "source-manifest-fingerprint-unknown",
            [RefusalCode.SourceMeasurementNotThroughHandle] =
                "source-measurement-not-through-handle",
            [RefusalCode.DestinationExtraEntry] = "destination-extra-entry",
            [RefusalCode.DestinationFileCollision] = "destination-file-collision",
            [RefusalCode.DestinationDigestMismatchAfterWrite] =
                "destination-digest-mismatch-after-write",
            [RefusalCode.InstalledVersionExists] = "installed-version-exists",
            [RefusalCode.RemovalTokenMismatch] = "removal-token-mismatch",
            [RefusalCode.RemovalUnexpectedEntry] = "removal-unexpected-entry",
            [RefusalCode.RemovalDirectoryNotEmpty] = "removal-directory-not-empty",
            [RefusalCode.RemovalManifestOrderViolation] = "removal-manifest-order-violation",
            [RefusalCode.RemovalRecordUnreadable] = "removal-record-unreadable",
            [RefusalCode.RemovalRecordSchemaInvalid] = "removal-record-schema-invalid",
            [RefusalCode.RemovalAncestorNotCreatedByThisTransaction] =
                "removal-ancestor-not-created-by-this-transaction",
            [RefusalCode.RemovalProtectedRootRefused] = "removal-protected-root-refused",
            [RefusalCode.RemovalWildcardRefused] = "removal-wildcard-refused",
            [RefusalCode.DeleteUnsupported] = "delete-unsupported",
            [RefusalCode.DeleteFailed] = "delete-failed",
            [RefusalCode.NativeAccessDenied] = "native-access-denied",
            [RefusalCode.NativeInvalidHandle] = "native-invalid-handle",
            [RefusalCode.NativeAlreadyExists] = "native-already-exists",
            [RefusalCode.NativeNotFound] = "native-not-found",
            [RefusalCode.NativeSharingViolation] = "native-sharing-violation",
            [RefusalCode.NativeReparsePointEncountered] = "native-reparse-point-encountered",
            [RefusalCode.NativeObjectPathInvalid] = "native-object-path-invalid",
            [RefusalCode.NativeNotSupported] = "native-not-supported",
            [RefusalCode.NativeResourceExhausted] = "native-resource-exhausted",
            [RefusalCode.NativeChangedUnderneath] = "native-changed-underneath",
            [RefusalCode.NativeUnexpectedFailure] = "native-unexpected-failure",
        };

    internal static string Of(RefusalCode code) =>
        RefusalNames.TryGetValue(code, out string? name) ? name : "internal-refusal";

    /// <summary>
    /// Every declared code has a spelling. A code with no entry would silently
    /// serialise as `internal-refusal`, collapsing two distinguishable outcomes
    /// into one and making a guard's removal invisible — the exact failure mode
    /// recorded in the release evidence section 25b.
    /// </summary>
    internal static bool EveryCodeHasASpelling()
    {
        foreach (RefusalCode code in Enum.GetValues<RefusalCode>())
        {
            if (!RefusalNames.ContainsKey(code))
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>Distinct spellings, so two codes cannot share one name.</summary>
    internal static bool EverySpellingIsDistinct()
    {
        HashSet<string> seen = new(StringComparer.Ordinal);
        foreach (KeyValuePair<RefusalCode, string> entry in RefusalNames)
        {
            if (!seen.Add(entry.Value))
            {
                return false;
            }
        }

        return true;
    }
}

/// <summary>
/// A refusal-or-value result. There is no exception-carrying variant: the
/// transaction boundary converts everything into one of these before anything
/// is written to standard output.
/// </summary>
internal readonly struct Outcome<T>
    where T : class
{
    private Outcome(T? value, RefusalCode refusal)
    {
        Value = value;
        Refusal = refusal;
    }

    internal T? Value { get; }

    internal RefusalCode Refusal { get; }

    internal bool Ok => Refusal == RefusalCode.None && Value is not null;

    internal static Outcome<T> Success(T value) => new(value, RefusalCode.None);

    internal static Outcome<T> Refused(RefusalCode refusal) =>
        new(null, refusal == RefusalCode.None ? RefusalCode.InternalRefusal : refusal);
}

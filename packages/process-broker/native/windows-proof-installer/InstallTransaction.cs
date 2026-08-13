using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace AiDevOs.WindowsProofInstaller;

/// <summary>
/// The exact open/create requests every step of the transaction issues.
///
/// They are constructed here, once, rather than at each call site, so a
/// reviewer can read the complete flag posture of the component in one place
/// and the self-test can pin each one by name. A call site that wanted
/// different flags would have to add a factory here, which is a visible change
/// to a reviewed file rather than an inline literal nobody notices.
/// </summary>
internal static class OpenRequests
{
    /// <summary>
    /// Object attributes for every handle-relative hop.
    ///
    /// <c>OBJ_DONT_REPARSE</c> is the reason this component exists: with it
    /// set, a junction or symbolic link anywhere in the chain fails the open
    /// instead of redirecting it, so a pre-planted link cannot make the
    /// transaction act on a directory it did not choose.
    ///
    /// <c>OBJ_CASE_INSENSITIVE</c> matches the Win32 filesystem's own
    /// behaviour. Omitting it would not add security — the filesystem is still
    /// case-insensitive — it would only make the component fail to find
    /// directories that exist, and the case-duplicate concern is handled where
    /// it actually lives, in the filename grammar and the ordinal-plus-
    /// case-folded duplicate scan of the source closure.
    ///
    /// <c>OBJ_KERNEL_HANDLE</c> is harmless in user mode and is set for
    /// consistency with the documented safe posture.
    /// </summary>
    internal const uint RelativeObjectAttributes =
        NtFlags.OBJ_CASE_INSENSITIVE | NtFlags.OBJ_KERNEL_HANDLE | NtFlags.OBJ_DONT_REPARSE;

    /// <summary>
    /// Object attributes for the single absolute open of the transaction, the
    /// volume root.
    ///
    /// <c>OBJ_DONT_REPARSE</c> is deliberately NOT set here, and this is the
    /// one honest exception in the whole design. An absolute NT path to a drive
    /// letter necessarily traverses an object-manager symbolic link —
    /// <c>\GLOBAL??\C:</c> is a symlink to <c>\Device\HarddiskVolumeN</c> — so
    /// <c>OBJ_DONT_REPARSE</c> would make the open fail on every stock Windows
    /// installation. That is a check nobody can satisfy, which is a check
    /// everybody disables.
    ///
    /// Two things bound the exception. The link is in the kernel object
    /// namespace rather than the filesystem, so re-binding it is an
    /// administrative act rather than something an unelevated attacker can do
    /// by creating a directory; and <c>\GLOBAL??</c> is used in preference to
    /// <c>\??</c> together with <c>OBJ_IGNORE_IMPERSONATED_DEVICEMAP</c>, so a
    /// per-logon-session device map — which an unelevated process in the same
    /// logon session CAN add entries to — cannot supply the drive letter.
    /// After the open, the handle's own reported volume identity, filesystem
    /// name, and final path are checked, so a successful redirection would have
    /// to have produced an object that also reports the expected identity.
    /// </summary>
    internal const uint VolumeRootObjectAttributes =
        NtFlags.OBJ_CASE_INSENSITIVE | NtFlags.OBJ_KERNEL_HANDLE |
        NtFlags.OBJ_IGNORE_IMPERSONATED_DEVICEMAP;

    /// <summary>
    /// Share mode for every directory the transaction retains.
    ///
    /// <c>FILE_SHARE_DELETE</c> is absent, which is the whole point: while this
    /// handle is open nothing can delete or rename the directory, so no
    /// ancestor can be swapped underneath the operation between one hop and the
    /// next. Read and write sharing are permitted because denying them would
    /// make the transaction fail whenever any unrelated process has the
    /// directory open, which on <c>C:\ProgramData</c> is always.
    /// </summary>
    internal const uint DirectoryShareAccess = NtFlags.FILE_SHARE_READ | NtFlags.FILE_SHARE_WRITE;

    private const uint DirectoryTraverseAccess =
        NtFlags.FILE_LIST_DIRECTORY | NtFlags.FILE_TRAVERSE | NtFlags.FILE_READ_ATTRIBUTES |
        NtFlags.READ_CONTROL | NtFlags.SYNCHRONIZE;

    private const uint DirectoryCreateAccess =
        DirectoryTraverseAccess | NtFlags.FILE_ADD_FILE | NtFlags.FILE_ADD_SUBDIRECTORY;

    private const uint DirectoryDeleteAccess = DirectoryTraverseAccess | NtFlags.DELETE;

    internal static HandleRelativeOpenRequest VolumeRoot(char driveLetter) =>
        new(
            "open-volume-root",
            string.Create(CultureInfo.InvariantCulture, $"{driveLetter}:\\"),
            DirectoryTraverseAccess,
            0,
            DirectoryShareAccess,
            NtFlags.FILE_OPEN,
            NtFlags.FILE_DIRECTORY_FILE | NtFlags.FILE_SYNCHRONOUS_IO_NONALERT,
            VolumeRootObjectAttributes,
            securityDescriptor: null);

    /// <summary>Traverse an existing directory component, refusing reparses.</summary>
    internal static HandleRelativeOpenRequest OpenExistingDirectory(string purpose, string name) =>
        new(
            purpose,
            name,
            DirectoryTraverseAccess,
            0,
            DirectoryShareAccess,
            NtFlags.FILE_OPEN,
            NtFlags.FILE_DIRECTORY_FILE | NtFlags.FILE_SYNCHRONOUS_IO_NONALERT,
            RelativeObjectAttributes,
            securityDescriptor: null);

    /// <summary>
    /// Open a component WITHOUT traversing it, so a reparse point can be
    /// inspected rather than followed. Used only on the refusal path, to
    /// establish what the unexpected object actually is for the operator
    /// review that an unrecognized object requires.
    /// </summary>
    internal static HandleRelativeOpenRequest InspectWithoutTraversing(string name) =>
        new(
            "inspect-link-without-traversing",
            name,
            NtFlags.FILE_READ_ATTRIBUTES | NtFlags.READ_CONTROL | NtFlags.SYNCHRONIZE,
            0,
            DirectoryShareAccess,
            NtFlags.FILE_OPEN,
            NtFlags.FILE_OPEN_REPARSE_POINT | NtFlags.FILE_SYNCHRONOUS_IO_NONALERT,
            NtFlags.OBJ_CASE_INSENSITIVE | NtFlags.OBJ_KERNEL_HANDLE,
            securityDescriptor: null);

    /// <summary>
    /// Create a protected directory atomically, with its intended security
    /// descriptor supplied AT CREATION.
    ///
    /// <c>FILE_CREATE</c> means an attacker who wins the race causes a
    /// collision and a refusal, never an adoption. <c>FILE_OPEN_IF</c> here
    /// would be the defect: it would silently accept whatever already exists,
    /// which is precisely what <c>New-Item -Force</c> did in the rejected
    /// PowerShell package (finding F4).
    /// </summary>
    internal static HandleRelativeOpenRequest CreateProtectedDirectory(
        string purpose,
        string name,
        SecurityDescriptorPlan plan) =>
        new(
            purpose,
            name,
            DirectoryCreateAccess,
            NtFlags.FILE_ATTRIBUTE_DIRECTORY,
            DirectoryShareAccess,
            NtFlags.FILE_CREATE,
            NtFlags.FILE_DIRECTORY_FILE | NtFlags.FILE_SYNCHRONOUS_IO_NONALERT,
            RelativeObjectAttributes,
            plan);

    /// <summary>
    /// Create the token-derived leaf with the same create-only and protected
    /// posture as every other created directory, plus DELETE on this one exact
    /// handle. The additional bit exists only so a refused install can remove
    /// the empty object it just created without reopening a name. Shared
    /// ancestors never receive this authority.
    /// </summary>
    internal static HandleRelativeOpenRequest CreateProtectedLeafDirectory(
        string name,
        SecurityDescriptorPlan plan) =>
        new(
            "create-protected-leaf-directory",
            name,
            DirectoryCreateAccess | NtFlags.DELETE,
            NtFlags.FILE_ATTRIBUTE_DIRECTORY,
            DirectoryShareAccess,
            NtFlags.FILE_CREATE,
            NtFlags.FILE_DIRECTORY_FILE | NtFlags.FILE_SYNCHRONOUS_IO_NONALERT,
            RelativeObjectAttributes,
            plan);

    internal static HandleRelativeOpenRequest OpenDirectoryForDeletion(string purpose, string name) =>
        new(
            purpose,
            name,
            DirectoryDeleteAccess,
            0,
            DirectoryShareAccess,
            NtFlags.FILE_OPEN,
            NtFlags.FILE_DIRECTORY_FILE | NtFlags.FILE_SYNCHRONOUS_IO_NONALERT,
            RelativeObjectAttributes,
            securityDescriptor: null);

    /// <summary>
    /// Open a source file for measurement.
    ///
    /// The share mode denies write AND delete, so the bytes that are hashed
    /// stay the bytes that are copied for as long as the handle is held. ADR
    /// 0017 section 6.6 is explicit that this closes content substitution and
    /// does not close path redirection; here path redirection is closed
    /// separately, by the handle-relative walk that produced the parent.
    /// </summary>
    internal static HandleRelativeOpenRequest OpenSourceFile(string name) =>
        new(
            "open-source-file",
            name,
            NtFlags.FILE_READ_DATA | NtFlags.FILE_READ_ATTRIBUTES | NtFlags.READ_CONTROL |
                NtFlags.SYNCHRONIZE,
            0,
            NtFlags.FILE_SHARE_READ,
            NtFlags.FILE_OPEN,
            NtFlags.FILE_NON_DIRECTORY_FILE | NtFlags.FILE_SYNCHRONOUS_IO_NONALERT,
            RelativeObjectAttributes,
            securityDescriptor: null);

    internal static HandleRelativeOpenRequest CreateDestinationFile(
        string name,
        SecurityDescriptorPlan plan) =>
        new(
            "create-destination-file",
            name,
            NtFlags.FILE_WRITE_DATA | NtFlags.FILE_READ_DATA | NtFlags.FILE_READ_ATTRIBUTES |
                NtFlags.FILE_WRITE_ATTRIBUTES | NtFlags.READ_CONTROL | NtFlags.SYNCHRONIZE,
            NtFlags.FILE_ATTRIBUTE_NORMAL,
            NtFlags.FILE_SHARE_NONE,
            NtFlags.FILE_CREATE,
            NtFlags.FILE_NON_DIRECTORY_FILE | NtFlags.FILE_SYNCHRONOUS_IO_NONALERT |
                NtFlags.FILE_WRITE_THROUGH,
            RelativeObjectAttributes,
            plan);

    internal static HandleRelativeOpenRequest OpenInstalledFileForVerification(string name) =>
        new(
            "open-installed-file-for-verification",
            name,
            NtFlags.FILE_READ_DATA | NtFlags.FILE_READ_ATTRIBUTES | NtFlags.READ_CONTROL |
                NtFlags.SYNCHRONIZE,
            0,
            NtFlags.FILE_SHARE_READ,
            NtFlags.FILE_OPEN,
            NtFlags.FILE_NON_DIRECTORY_FILE | NtFlags.FILE_SYNCHRONOUS_IO_NONALERT,
            RelativeObjectAttributes,
            securityDescriptor: null);

    internal static HandleRelativeOpenRequest OpenFileForDeletion(string name) =>
        new(
            "open-installed-file-for-deletion",
            name,
            NtFlags.DELETE | NtFlags.FILE_READ_DATA | NtFlags.FILE_READ_ATTRIBUTES |
                NtFlags.READ_CONTROL | NtFlags.SYNCHRONIZE,
            0,
            NtFlags.FILE_SHARE_READ,
            NtFlags.FILE_OPEN,
            NtFlags.FILE_NON_DIRECTORY_FILE | NtFlags.FILE_SYNCHRONOUS_IO_NONALERT,
            RelativeObjectAttributes,
            securityDescriptor: null);
}

/// <summary>One derived, purely computed description of what would be done.</summary>
internal sealed class InstallPlan
{
    private InstallPlan(
        string runToken,
        string candidateId,
        IReadOnlyList<string> destinationComponents,
        IReadOnlyList<string> fileNames)
    {
        RunToken = runToken;
        CandidateId = candidateId;
        DestinationComponents = destinationComponents;
        FileNames = fileNames;
    }

    internal string RunToken { get; }

    internal string CandidateId { get; }

    /// <summary>
    /// The components below <c>CommonApplicationData</c>, in order. This is a
    /// list of NAMES, not a path: nothing downstream ever concatenates them,
    /// because concatenating them would produce exactly the string an attacker
    /// would want the transaction to re-resolve.
    /// </summary>
    internal IReadOnlyList<string> DestinationComponents { get; }

    internal IReadOnlyList<string> FileNames { get; }

    internal static Outcome<InstallPlan> Derive(string runToken, ProofCandidate candidate)
    {
        if (!NameGrammar.IsRunToken(runToken))
        {
            return Outcome<InstallPlan>.Refused(RefusalCode.TokenMalformed);
        }

        string[] components =
        [
            ProofConfiguration.InstallRootFirstComponent,
            ProofConfiguration.InstallRootSecondComponent,
            runToken,
        ];
        foreach (string component in components)
        {
            if (NameGrammar.Validate(component) != RefusalCode.None)
            {
                return Outcome<InstallPlan>.Refused(RefusalCode.ComponentNameInvalid);
            }
        }

        List<string> files = [];
        HashSet<string> caseFolded = new(StringComparer.OrdinalIgnoreCase);
        foreach (string name in candidate.FileNames)
        {
            if (NameGrammar.Validate(name) != RefusalCode.None)
            {
                return Outcome<InstallPlan>.Refused(RefusalCode.SourceFileNameInvalid);
            }

            // The manifest and the install record are produced by this
            // component, not copied from the source. A candidate that listed
            // either would make the source able to supply its own manifest,
            // which is the one file whose contents must not come from the thing
            // being measured.
            if (string.Equals(name, ProofConfiguration.InstalledManifestFileName, StringComparison.OrdinalIgnoreCase) ||
                string.Equals(name, ProofConfiguration.InstallRecordFileName, StringComparison.OrdinalIgnoreCase))
            {
                return Outcome<InstallPlan>.Refused(RefusalCode.SourceFileNameInvalid);
            }

            if (!caseFolded.Add(name))
            {
                return Outcome<InstallPlan>.Refused(RefusalCode.SourceFileDuplicateCaseInsensitive);
            }

            files.Add(name);
        }

        if (files.Count == 0 || files.Count > ProofConfiguration.MaximumInstalledFileCount)
        {
            return Outcome<InstallPlan>.Refused(RefusalCode.PlanNotDerivable);
        }

        files.Sort(StringComparer.Ordinal);
        return Outcome<InstallPlan>.Success(
            new InstallPlan(runToken, candidate.CandidateId, components, files));
    }

    internal CanonicalObject ToCanonical() =>
        new CanonicalObject()
            .Set("candidateId", CandidateId)
            .Set("destinationComponents", DestinationComponents)
            .Set("fileNames", FileNames)
            .Set("installRecordFileName", ProofConfiguration.InstallRecordFileName)
            .Set("manifestFileName", ProofConfiguration.InstalledManifestFileName)
            .Set("runToken", RunToken);
}

/// <summary>An ancestor the transaction opened, with what it learned about it.</summary>
internal sealed class AncestorRecord
{
    internal AncestorRecord(
        string name,
        OpenedObject handle,
        ObjectFacts facts,
        bool createdByThisTransaction,
        bool protectionRequired)
    {
        Name = name;
        Handle = handle;
        Facts = facts;
        CreatedByThisTransaction = createdByThisTransaction;
        ProtectionRequired = protectionRequired;
    }

    internal string Name { get; }

    internal OpenedObject Handle { get; }

    internal ObjectFacts Facts { get; }

    internal bool CreatedByThisTransaction { get; }

    /// <summary>
    /// Whether the full forbidden-rights mask applies to this component.
    ///
    /// It does NOT apply to <c>C:\ProgramData</c>, which on stock Windows
    /// grants <c>BUILTIN\Users</c> write-class rights by default. Requiring
    /// their absence there would make the transaction refuse on every unmodified
    /// Windows installation. What IS required on every ancestor, including
    /// <c>C:\ProgramData</c>, is the absence of the delete-and-control class —
    /// <c>DELETE</c>, <c>FILE_DELETE_CHILD</c>, <c>WRITE_DAC</c>,
    /// <c>WRITE_OWNER</c> — because those are the rights that let an unelevated
    /// principal remove or re-permission a protected child regardless of the
    /// child's own DACL. That distinction is the correction recorded as F5 in
    /// the release evidence, reached by measuring the real host rather than by
    /// reasoning about it.
    /// </summary>
    internal bool ProtectionRequired { get; }
}

/// <summary>The result of an install or removal attempt.</summary>
internal sealed class TransactionReport
{
    internal TransactionReport(
        string operation,
        RefusalCode refusal,
        string failedStep,
        IReadOnlyList<string> completedSteps,
        RollbackReport? rollback = null)
    {
        Operation = operation;
        Refusal = refusal;
        FailedStep = failedStep;
        CompletedSteps = completedSteps;
        Rollback = rollback ?? RollbackReport.NotRequired;
    }

    internal string Operation { get; }

    internal RefusalCode Refusal { get; }

    internal string FailedStep { get; }

    internal IReadOnlyList<string> CompletedSteps { get; }

    internal RollbackReport Rollback { get; }

    internal bool Succeeded => Refusal == RefusalCode.None;

    internal CanonicalObject ToCanonical() =>
        new CanonicalObject()
            .Set("code", ProtocolNames.Of(Refusal))
            .Set("completedSteps", CompletedSteps)
            .Set("failedStep", FailedStep)
            .Set("operation", Operation)
            .Set("rollbackCode", ProtocolNames.Of(Rollback.Refusal))
            .Set("rollbackFailedStep", Rollback.FailedStep)
            .Set("rollbackStatus", Rollback.Status)
            .Set("status", Succeeded ? "completed" : "refused");
}

/// <summary>
/// A finite, body-free account of the install rollback path.
///
/// The primary transaction refusal remains on <see cref="TransactionReport"/>.
/// A rollback refusal is deliberately separate so cleanup failure can never
/// replace or disguise the fault that caused the install to stop.
/// </summary>
internal sealed class RollbackReport
{
    private RollbackReport(string status, RefusalCode refusal, string failedStep)
    {
        Status = status;
        Refusal = refusal;
        FailedStep = failedStep;
    }

    internal static RollbackReport NotRequired { get; } =
        new("not-required", RefusalCode.None, string.Empty);

    internal static RollbackReport Completed { get; } =
        new("completed", RefusalCode.None, string.Empty);

    internal static RollbackReport Refused(RefusalCode refusal, string failedStep) =>
        new(
            "refused",
            refusal == RefusalCode.None ? RefusalCode.InternalRefusal : refusal,
            failedStep);

    internal string Status { get; }

    internal RefusalCode Refusal { get; }

    internal string FailedStep { get; }
}

/// <summary>
/// The handle-relative install and removal transaction (ADR 0018 sections 2.1
/// to 2.5).
///
/// Both entry points take a <see cref="ReviewedProofModeAuthorization"/> BY
/// SIGNATURE. In a sealed build that type has no reachable constructor, so a
/// sealed binary cannot express a call to either one with a non-null value, and
/// the gate refuses the null. There is no environment variable, switch, or
/// configuration that changes this: it is the shape of the method.
///
/// Every step below acts on a handle. Nothing re-resolves a path, nothing
/// concatenates one, and nothing accepts one after the initial parse. The
/// difference matters: a name can be re-bound between the moment it is checked
/// and the moment it is used, and a handle cannot.
/// </summary>
internal static class InstallTransaction
{
    /// <summary>
    /// The delete-and-control class. Absent from every ancestor, including the
    /// shared ones this transaction does not own.
    /// </summary>
    internal const uint AncestorForbiddenMask =
        NtFlags.DELETE | NtFlags.FILE_DELETE_CHILD | NtFlags.WRITE_DAC | NtFlags.WRITE_OWNER;

    internal static TransactionReport Install(
        IHandleRelativeFileSystem fs,
        string runToken,
        ProofCandidate candidate,
        string sourceRootPath,
        ReviewedProofModeAuthorization? authorization)
    {
        try
        {
            return InstallCore(fs, runToken, candidate, sourceRootPath, authorization);
        }
        catch
        {
            // Covers adapter failures before the stateful inner boundary (for
            // example proof-identity resolution) and any unforeseen close-time
            // exception. No exception body, path, or caller text crosses the
            // command boundary.
            return new TransactionReport(
                "install",
                RefusalCode.InternalRefusal,
                "install-boundary",
                []);
        }
    }

    private static TransactionReport InstallCore(
        IHandleRelativeFileSystem fs,
        string runToken,
        ProofCandidate candidate,
        string sourceRootPath,
        ReviewedProofModeAuthorization? authorization)
    {
        ArgumentNullException.ThrowIfNull(fs);
        ArgumentNullException.ThrowIfNull(candidate);
        List<string> steps = [];

        // The gate is the first thing on the path, before any argument is even
        // examined. If it were later, a malformed argument would be reported
        // from a sealed build in a way that told the caller how far it got.
        RefusalCode gate = MutationGate.Authorize(authorization);
        if (gate != RefusalCode.None)
        {
            return Refuse("install", gate, "authorize", steps);
        }

        Outcome<InstallPlan> planned = InstallPlan.Derive(runToken, candidate);
        if (!planned.Ok || planned.Value is null)
        {
            return Refuse("install", planned.Refusal, "derive-plan", steps);
        }

        InstallPlan plan = planned.Value;
        steps.Add("derive-plan");

        RefusalCode sourceParse = NameGrammar.TryParseDriveRootedPath(
            sourceRootPath,
            out char sourceDrive,
            out IReadOnlyList<string> sourceComponents);
        if (sourceParse != RefusalCode.None)
        {
            return Refuse("install", sourceParse, "parse-source-path", steps);
        }

        steps.Add("parse-source-path");

        Outcome<ProofIdentity> identityOutcome = fs.ResolveProofIdentity();
        if (!identityOutcome.Ok || identityOutcome.Value is null)
        {
            return Refuse("install", identityOutcome.Refusal, "resolve-proof-identity", steps);
        }

        ProofIdentity identity = identityOutcome.Value;
        if (identity.IsWellKnownPrivileged)
        {
            return Refuse(
                "install",
                RefusalCode.ProofIdentityUnacceptable,
                "resolve-proof-identity",
                steps);
        }

        steps.Add("resolve-proof-identity");

        Outcome<SecurityDescriptorPlan> directoryPlan = SecurityDescriptorPlan.ForDirectory(identity);
        if (!directoryPlan.Ok || directoryPlan.Value is null)
        {
            return Refuse("install", directoryPlan.Refusal, "compose-directory-sd", steps);
        }

        Outcome<SecurityDescriptorPlan> filePlan = SecurityDescriptorPlan.ForFile(identity);
        if (!filePlan.Ok || filePlan.Value is null)
        {
            return Refuse("install", filePlan.Refusal, "compose-file-sd", steps);
        }

        steps.Add("compose-security-descriptors");

        List<OpenedObject> retained = [];
        List<AncestorRecord> ancestors = [];
        bool tokenLeafCreated = false;
        try
        {
            Outcome<KnownFolderResolution> folder = fs.ResolveCommonApplicationData();
            if (!folder.Ok || folder.Value is null)
            {
                return Refuse("install", folder.Refusal, "resolve-known-folder", steps);
            }

            KnownFolderResolution known = folder.Value;
            foreach (string component in known.Components)
            {
                if (NameGrammar.Validate(component) != RefusalCode.None)
                {
                    return Refuse(
                        "install",
                        RefusalCode.KnownFolderPathNotCanonical,
                        "resolve-known-folder",
                        steps);
                }
            }

            if (known.Components.Count == 0 ||
                known.DriveLetter < 'A' || known.DriveLetter > 'Z')
            {
                return Refuse(
                    "install",
                    RefusalCode.KnownFolderPathNotDriveRooted,
                    "resolve-known-folder",
                    steps);
            }

            steps.Add("resolve-known-folder");

            Outcome<AncestorRecord> destinationLeafOutcome = OpenDestinationAncestors(
                fs,
                known,
                plan,
                directoryPlan.Value,
                retained,
                steps,
                out ancestors,
                out tokenLeafCreated,
                out RefusalCode ancestorRefusal,
                out string ancestorStep);
            if (!destinationLeafOutcome.Ok || destinationLeafOutcome.Value is null)
            {
                return RefuseInstallWithRollback(
                    fs,
                    ancestorRefusal,
                    ancestorStep,
                    steps,
                    ancestors,
                    tokenLeafCreated,
                    plan,
                    directoryPlan.Value);
            }

            AncestorRecord leaf = destinationLeafOutcome.Value;

            // ADR 0018 section 2.3: the protection is verified by the kernel,
            // not by reading back the ACL we asked for. Reading back what we
            // wrote proves the write happened; AccessCheck proves the write
            // means what we intended it to mean.
            foreach (AncestorRecord ancestor in ancestors)
            {
                RefusalCode protection = VerifyProtection(fs, ancestor);
                if (protection != RefusalCode.None)
                {
                    return RefuseInstallWithRollback(
                        fs,
                        protection,
                        "verify-protection",
                        steps,
                        ancestors,
                        tokenLeafCreated,
                        plan,
                        directoryPlan.Value);
                }
            }

            steps.Add("verify-protection");

            Outcome<OpenedObject> sourceRoot = WalkAbsolute(
                fs,
                sourceDrive,
                sourceComponents,
                "open-source-component",
                retained,
                out RefusalCode sourceRefusal);
            if (!sourceRoot.Ok || sourceRoot.Value is null)
            {
                return RefuseInstallWithRollback(
                    fs,
                    sourceRefusal == RefusalCode.NativeReparsePointEncountered
                        ? RefusalCode.SourceRootIsReparsePoint
                        : sourceRefusal == RefusalCode.None
                            ? RefusalCode.SourceRootUnopenable
                            : sourceRefusal,
                    "open-source-root",
                    steps,
                    ancestors,
                    tokenLeafCreated,
                    plan,
                    directoryPlan.Value);
            }

            steps.Add("open-source-root");

            Outcome<Dictionary<string, byte[]>> measured = MeasureSourceClosure(
                fs,
                sourceRoot.Value,
                plan,
                candidate,
                retained,
                out RefusalCode measureRefusal);
            if (!measured.Ok || measured.Value is null)
            {
                return RefuseInstallWithRollback(
                    fs,
                    measureRefusal,
                    "measure-source-closure",
                    steps,
                    ancestors,
                    tokenLeafCreated,
                    plan,
                    directoryPlan.Value);
            }

            steps.Add("measure-source-closure");

            // Re-verify, immediately before anything is created, that every
            // retained ancestor is still the OBJECT it was when it was opened.
            //
            // Holding a handle is what makes this checkable and is also what
            // should make it unnecessary: a directory with an open handle that
            // denies delete sharing cannot be renamed or replaced. The check is
            // here anyway because "should be impossible" and "is impossible"
            // are different propositions, and this is the last point at which
            // the difference can still be acted on. It compares the identity
            // read at open time with the identity read now, so it fails on a
            // swap even when every other property still matches.
            RefusalCode unchanged = RequireAncestorIdentitiesUnchanged(fs, ancestors);
            if (unchanged != RefusalCode.None)
            {
                return RefuseInstallWithRollback(
                    fs,
                    unchanged,
                    "assert-chain-retained-before-create",
                    steps,
                    ancestors,
                    tokenLeafCreated,
                    plan,
                    directoryPlan.Value);
            }

            RefusalCode copied = CopyClosure(
                fs,
                leaf,
                plan,
                measured.Value,
                filePlan.Value,
                steps);
            if (copied != RefusalCode.None)
            {
                return RefuseInstallWithRollback(
                    fs,
                    copied,
                    "copy-closure",
                    steps,
                    ancestors,
                    tokenLeafCreated,
                    plan,
                    directoryPlan.Value);
            }

            steps.Add("copy-closure");

            RefusalCode verified = VerifyInstalledClosure(fs, leaf, plan, measured.Value, filePlan.Value);
            if (verified != RefusalCode.None)
            {
                return RefuseInstallWithRollback(
                    fs,
                    verified,
                    "re-measure-installed-closure",
                    steps,
                    ancestors,
                    tokenLeafCreated,
                    plan,
                    directoryPlan.Value);
            }

            steps.Add("re-measure-installed-closure");
            return new TransactionReport("install", RefusalCode.None, string.Empty, steps);
        }
        catch
        {
            return RefuseInstallWithRollback(
                fs,
                RefusalCode.InternalRefusal,
                "install-boundary",
                steps,
                ancestors,
                tokenLeafCreated,
                plan,
                directoryPlan.Value);
        }
        finally
        {
            // Ancestor handles are held for the WHOLE transaction and released
            // only here, in reverse order. Releasing one early would reopen the
            // rename window this component exists to close, so the release is a
            // single place rather than a per-step concern.
            for (int index = retained.Count - 1; index >= 0; index--)
            {
                retained[index].Dispose();
            }
        }
    }

    internal static TransactionReport Remove(
        IHandleRelativeFileSystem fs,
        string runToken,
        ReviewedProofModeAuthorization? authorization)
    {
        try
        {
            return RemoveCore(fs, runToken, authorization);
        }
        catch
        {
            // The public transaction boundary is finite even when an injected
            // filesystem throws before the inner retained-handle scope exists.
            return new TransactionReport(
                "remove",
                RefusalCode.InternalRefusal,
                "remove-boundary",
                []);
        }
    }

    private static TransactionReport RemoveCore(
        IHandleRelativeFileSystem fs,
        string runToken,
        ReviewedProofModeAuthorization? authorization)
    {
        ArgumentNullException.ThrowIfNull(fs);
        List<string> steps = [];

        RefusalCode gate = MutationGate.Authorize(authorization);
        if (gate != RefusalCode.None)
        {
            return Refuse("remove", gate, "authorize", steps);
        }

        if (!NameGrammar.IsRunToken(runToken))
        {
            return Refuse("remove", RefusalCode.TokenMalformed, "validate-token", steps);
        }

        steps.Add("validate-token");

        Outcome<ProofIdentity> identityOutcome = fs.ResolveProofIdentity();
        if (!identityOutcome.Ok || identityOutcome.Value is null)
        {
            return Refuse("remove", identityOutcome.Refusal, "resolve-proof-identity", steps);
        }

        if (identityOutcome.Value.IsWellKnownPrivileged)
        {
            return Refuse(
                "remove",
                RefusalCode.ProofIdentityUnacceptable,
                "resolve-proof-identity",
                steps);
        }

        Outcome<SecurityDescriptorPlan> directoryPlan =
            SecurityDescriptorPlan.ForDirectory(identityOutcome.Value);
        if (!directoryPlan.Ok || directoryPlan.Value is null)
        {
            return Refuse("remove", directoryPlan.Refusal, "compose-directory-sd", steps);
        }

        List<OpenedObject> retained = [];
        try
        {
            Outcome<KnownFolderResolution> folder = fs.ResolveCommonApplicationData();
            if (!folder.Ok || folder.Value is null)
            {
                return Refuse("remove", folder.Refusal, "resolve-known-folder", steps);
            }

            foreach (string component in folder.Value.Components)
            {
                if (NameGrammar.Validate(component) != RefusalCode.None)
                {
                    return Refuse(
                        "remove",
                        RefusalCode.KnownFolderPathNotCanonical,
                        "resolve-known-folder",
                        steps);
                }
            }

            if (folder.Value.Components.Count == 0 ||
                folder.Value.DriveLetter < 'A' || folder.Value.DriveLetter > 'Z')
            {
                return Refuse(
                    "remove",
                    RefusalCode.KnownFolderPathNotDriveRooted,
                    "resolve-known-folder",
                    steps);
            }

            Outcome<OpenedObject> programData = WalkAbsolute(
                fs,
                folder.Value.DriveLetter,
                folder.Value.Components,
                "open-known-folder-component",
                retained,
                out RefusalCode walkRefusal);
            if (!programData.Ok || programData.Value is null)
            {
                return Refuse("remove", walkRefusal, "open-known-folder", steps);
            }

            Outcome<ObjectFacts> programDataFacts = fs.QueryFacts(programData.Value);
            if (!programDataFacts.Ok || programDataFacts.Value is null)
            {
                return Refuse("remove", programDataFacts.Refusal, "open-known-folder", steps);
            }

            steps.Add("open-known-folder");

            // The three components below CommonApplicationData. The two shared
            // ancestors are traverse-only because this protocol never deletes
            // them; only the exact run-token leaf receives DELETE. Nothing
            // below is ever named by a path.
            string[] names =
            [
                ProofConfiguration.InstallRootFirstComponent,
                ProofConfiguration.InstallRootSecondComponent,
                runToken,
            ];

            List<OpenedObject> chain = [];
            List<AncestorRecord> removalAncestors =
            [
                new AncestorRecord(
                    folder.Value.Components[^1],
                    programData.Value,
                    programDataFacts.Value,
                    createdByThisTransaction: false,
                    protectionRequired: false),
            ];
            OpenedObject parent = programData.Value;
            for (int index = 0; index < names.Length; index++)
            {
                string name = names[index];
                HandleRelativeOpenRequest request = index == names.Length - 1
                    ? OpenRequests.OpenDirectoryForDeletion("open-removal-component", name)
                    : OpenRequests.OpenExistingDirectory("open-removal-component", name);
                Outcome<OpenedObject> opened = fs.OpenRelative(
                    parent,
                    request);
                if (!opened.Ok || opened.Value is null)
                {
                    return Refuse("remove", opened.Refusal, "open-removal-component", steps);
                }

                retained.Add(opened.Value);
                RefusalCode directoryCheck = RequireIntactDirectory(fs, opened.Value);
                if (directoryCheck != RefusalCode.None)
                {
                    return Refuse("remove", directoryCheck, "verify-removal-component", steps);
                }

                Outcome<ObjectFacts> facts = fs.QueryFacts(opened.Value);
                if (!facts.Ok || facts.Value is null)
                {
                    return Refuse("remove", facts.Refusal, "verify-removal-component", steps);
                }

                if (facts.Value.VolumeSerialNumber != programDataFacts.Value.VolumeSerialNumber)
                {
                    return Refuse(
                        "remove",
                        RefusalCode.ComponentVolumeMismatch,
                        "verify-removal-component",
                        steps);
                }

                Outcome<SecuritySnapshot> security = fs.QuerySecurity(opened.Value);
                if (!security.Ok || security.Value is null)
                {
                    return Refuse("remove", security.Refusal, "verify-removal-component", steps);
                }

                RefusalCode exactSecurity = directoryPlan.Value.RequireExactMatch(security.Value);
                if (exactSecurity != RefusalCode.None)
                {
                    return Refuse("remove", exactSecurity, "verify-removal-component", steps);
                }

                chain.Add(opened.Value);
                removalAncestors.Add(new AncestorRecord(
                    name,
                    opened.Value,
                    facts.Value,
                    createdByThisTransaction: false,
                    protectionRequired: true));
                parent = opened.Value;
            }

            RefusalCode removalChain = VerifyExactProtectedChain(
                fs,
                removalAncestors,
                names,
                directoryPlan.Value);
            if (removalChain != RefusalCode.None)
            {
                return Refuse("remove", removalChain, "verify-removal-chain", steps);
            }

            steps.Add("open-removal-chain");

            OpenedObject leaf = chain[^1];
            Outcome<DirectoryListing> listing = fs.ListDirectory(leaf);
            if (!listing.Ok || listing.Value is null)
            {
                return Refuse("remove", listing.Refusal, "enumerate-leaf", steps);
            }

            if (listing.Value.DirectoryNames.Count > 0)
            {
                // An unrecognized object is a refusal requiring operator review,
                // not something to clean up. Silently deleting an object you
                // cannot explain is how a cleanup routine becomes an
                // arbitrary-delete primitive.
                return Refuse("remove", RefusalCode.RemovalUnexpectedEntry, "enumerate-leaf", steps);
            }

            if (listing.Value.IsEmpty)
            {
                RefusalCode recovered = RecoverManifestlessEmptyLeaf(
                    fs,
                    leaf,
                    removalAncestors,
                    names,
                    directoryPlan.Value,
                    out string recoveryStep);
                if (recovered != RefusalCode.None)
                {
                    return Refuse("remove", recovered, recoveryStep, steps);
                }

                steps.Add("prove-manifestless-empty-leaf");
                steps.Add("delete-manifestless-empty-leaf");
                steps.Add("retain-shared-ancestors");
                return new TransactionReport("remove", RefusalCode.None, string.Empty, steps);
            }

            Outcome<InstalledManifest> manifest = ReadInstalledManifest(fs, leaf, runToken);
            if (!manifest.Ok || manifest.Value is null)
            {
                return Refuse("remove", manifest.Refusal, "read-installed-manifest", steps);
            }

            steps.Add("read-installed-manifest");

            HashSet<string> expected = new(StringComparer.Ordinal);
            foreach (string name in manifest.Value.FileNames)
            {
                expected.Add(name);
            }

            expected.Add(ProofConfiguration.InstalledManifestFileName);
            expected.Add(ProofConfiguration.InstallRecordFileName);
            foreach (string present in listing.Value.FileNames)
            {
                if (!expected.Contains(present))
                {
                    return Refuse(
                        "remove",
                        RefusalCode.RemovalUnexpectedEntry,
                        "enumerate-leaf",
                        steps);
                }
            }

            steps.Add("enumerate-leaf");

            // Payload first, then the install record, then the manifest LAST.
            // The ordering is what makes an interrupted removal recognizable:
            // a leaf that still has a manifest is a leaf whose removal did not
            // finish, and a leaf with no manifest and no payload is a leaf that
            // finished. A removal that deleted the manifest first would leave
            // an indistinguishable half state.
            List<string> ordered = [];
            foreach (string name in manifest.Value.FileNames)
            {
                if (!string.Equals(name, ProofConfiguration.InstalledManifestFileName, StringComparison.Ordinal) &&
                    !string.Equals(name, ProofConfiguration.InstallRecordFileName, StringComparison.Ordinal))
                {
                    ordered.Add(name);
                }
            }

            ordered.Sort(StringComparer.Ordinal);
            ordered.Add(ProofConfiguration.InstallRecordFileName);
            ordered.Add(ProofConfiguration.InstalledManifestFileName);

            foreach (string name in ordered)
            {
                RefusalCode deleted = DeleteExactFile(fs, leaf, name, listing.Value);
                if (deleted != RefusalCode.None)
                {
                    return Refuse("remove", deleted, "delete-manifest-listed-file", steps);
                }
            }

            steps.Add("delete-manifest-listed-files");

            Outcome<DirectoryListing> after = fs.ListDirectory(leaf);
            if (!after.Ok || after.Value is null)
            {
                return Refuse("remove", after.Refusal, "prove-leaf-empty", steps);
            }

            if (!after.Value.IsEmpty)
            {
                return Refuse("remove", RefusalCode.RemovalDirectoryNotEmpty, "prove-leaf-empty", steps);
            }

            steps.Add("prove-leaf-empty");

            RefusalCode leafDeleted = fs.DeleteThroughHandle(leaf);
            if (leafDeleted != RefusalCode.None)
            {
                return Refuse("remove", leafDeleted, "delete-leaf-directory", steps);
            }

            steps.Add("delete-leaf-directory");

            // The two shared ancestors are retained unconditionally. Their
            // handles were deliberately opened without DELETE, so there is no
            // latent branch that could broaden this leaf-only cleanup later.
            steps.Add("retain-shared-ancestors");

            return new TransactionReport("remove", RefusalCode.None, string.Empty, steps);
        }
        catch
        {
            return Refuse("remove", RefusalCode.InternalRefusal, "remove-boundary", steps);
        }
        finally
        {
            for (int index = retained.Count - 1; index >= 0; index--)
            {
                retained[index].Dispose();
            }
        }
    }

    // ------------------------------------------------------------- ancestors

    private static Outcome<AncestorRecord> OpenDestinationAncestors(
        IHandleRelativeFileSystem fs,
        KnownFolderResolution known,
        InstallPlan plan,
        SecurityDescriptorPlan directoryPlan,
        List<OpenedObject> retained,
        List<string> steps,
        out List<AncestorRecord> ancestors,
        out bool tokenLeafCreated,
        out RefusalCode refusal,
        out string failedStep)
    {
        ancestors = [];
        tokenLeafCreated = false;
        refusal = RefusalCode.None;
        failedStep = string.Empty;

        Outcome<OpenedObject> programData = WalkAbsolute(
            fs,
            known.DriveLetter,
            known.Components,
            "open-known-folder-component",
            retained,
            out RefusalCode walkRefusal);
        if (!programData.Ok || programData.Value is null)
        {
            refusal = walkRefusal;
            failedStep = "open-known-folder";
            return Outcome<AncestorRecord>.Refused(walkRefusal);
        }

        Outcome<ObjectFacts> programDataFacts = fs.QueryFacts(programData.Value);
        if (!programDataFacts.Ok || programDataFacts.Value is null)
        {
            refusal = programDataFacts.Refusal;
            failedStep = "open-known-folder";
            return Outcome<AncestorRecord>.Refused(programDataFacts.Refusal);
        }

        // C:\ProgramData is a shared ancestor this transaction does not own and
        // must not modify. It is still checked, and the delete-class rights are
        // still required to be absent for the proof identity.
        ancestors.Add(new AncestorRecord(
            known.Components[^1],
            programData.Value,
            programDataFacts.Value,
            createdByThisTransaction: false,
            protectionRequired: false));

        steps.Add("open-known-folder");

        OpenedObject parent = programData.Value;
        for (int index = 0; index < plan.DestinationComponents.Count; index++)
        {
            string name = plan.DestinationComponents[index];
            bool isLeaf = index == plan.DestinationComponents.Count - 1;

            // Create-only first. A collision is not a reason to look again: on
            // the leaf it is an existing installed version and is refused
            // outright, and on a shared ancestor it means something already
            // owns that name and has to prove it is the exact approved object.
            HandleRelativeOpenRequest createRequest = isLeaf
                ? OpenRequests.CreateProtectedLeafDirectory(name, directoryPlan)
                : OpenRequests.CreateProtectedDirectory(
                    "create-protected-directory",
                    name,
                    directoryPlan);
            Outcome<OpenedObject> created = fs.OpenRelative(parent, createRequest);

            OpenedObject handle;
            bool createdHere;
            if (created.Ok && created.Value is not null)
            {
                handle = created.Value;
                createdHere = true;
                retained.Add(handle);
                if (isLeaf)
                {
                    tokenLeafCreated = true;
                }
            }
            else if (created.Refusal == RefusalCode.NativeAlreadyExists)
            {
                if (isLeaf)
                {
                    refusal = RefusalCode.InstalledVersionExists;
                    failedStep = "create-protected-directory";
                    return Outcome<AncestorRecord>.Refused(refusal);
                }

                Outcome<OpenedObject> opened = fs.OpenRelative(
                    parent,
                    OpenRequests.OpenExistingDirectory("open-existing-ancestor", name));
                if (!opened.Ok || opened.Value is null)
                {
                    refusal = opened.Refusal;
                    failedStep = "open-existing-ancestor";
                    return Outcome<AncestorRecord>.Refused(refusal);
                }

                handle = opened.Value;
                createdHere = false;
                retained.Add(handle);

                // An existing component is REFUSED unless it already matches
                // exactly. It is never repaired: repairing means adopting an
                // object that an unelevated principal may have created and
                // still owns, and adoption is the outcome create-only
                // disposition exists to prevent.
                Outcome<SecuritySnapshot> security = fs.QuerySecurity(handle);
                if (!security.Ok || security.Value is null)
                {
                    refusal = security.Refusal;
                    failedStep = "inspect-existing-ancestor";
                    return Outcome<AncestorRecord>.Refused(refusal);
                }

                // There is deliberately NO separate "is the owner one of the
                // trusted principals" check here. An earlier revision had one,
                // and the reintroduce-and-observe pass showed it was pure
                // redundancy: RequireExactMatch already requires the owner to
                // equal the plan's owner, which is a STRICTER condition than
                // membership of a trusted set, and it returns the same
                // owner-untrusted code. Deleting the weaker check changed
                // nothing observable, which is the definition of a guard that
                // is not doing the work — and a suite full of those is how
                // "the tests are green" stops meaning "the guards are on".
                RefusalCode exact = directoryPlan.RequireExactMatch(security.Value);
                if (exact != RefusalCode.None)
                {
                    refusal = exact;
                    failedStep = "inspect-existing-ancestor";
                    return Outcome<AncestorRecord>.Refused(refusal);
                }
            }
            else
            {
                refusal = created.Refusal == RefusalCode.None
                    ? RefusalCode.CreateFailed
                    : created.Refusal;
                failedStep = "create-protected-directory";
                return Outcome<AncestorRecord>.Refused(refusal);
            }

            RefusalCode intact = RequireIntactDirectory(fs, handle);
            if (intact != RefusalCode.None)
            {
                refusal = intact;
                failedStep = "verify-created-directory";
                return Outcome<AncestorRecord>.Refused(refusal);
            }

            if (createdHere)
            {
                // What landed must be what was asked for. Reading the DACL back
                // through the SAME handle that created it proves the descriptor
                // supplied in OBJECT_ATTRIBUTES took effect, and does so without
                // re-resolving the name.
                Outcome<SecuritySnapshot> security = fs.QuerySecurity(handle);
                if (!security.Ok || security.Value is null)
                {
                    refusal = security.Refusal;
                    failedStep = "verify-created-directory";
                    return Outcome<AncestorRecord>.Refused(refusal);
                }

                RefusalCode exact = directoryPlan.RequireExactMatch(security.Value);
                if (exact != RefusalCode.None)
                {
                    refusal = exact == RefusalCode.None ? RefusalCode.InternalRefusal : exact;
                    failedStep = "verify-created-directory";
                    return Outcome<AncestorRecord>.Refused(refusal);
                }
            }

            Outcome<ObjectFacts> facts = fs.QueryFacts(handle);
            if (!facts.Ok || facts.Value is null)
            {
                refusal = facts.Refusal;
                failedStep = "verify-created-directory";
                return Outcome<AncestorRecord>.Refused(refusal);
            }

            if (facts.Value.VolumeSerialNumber != programDataFacts.Value.VolumeSerialNumber)
            {
                refusal = RefusalCode.ComponentVolumeMismatch;
                failedStep = "verify-created-directory";
                return Outcome<AncestorRecord>.Refused(refusal);
            }

            ancestors.Add(new AncestorRecord(
                name,
                handle,
                facts.Value,
                createdHere,
                protectionRequired: true));
            parent = handle;
        }

        steps.Add("open-destination-chain");
        return Outcome<AncestorRecord>.Success(ancestors[^1]);
    }

    /// <summary>
    /// Opens a drive-rooted path one component at a time, each relative to the
    /// already-open parent. The path string is consumed here and never travels
    /// any further.
    /// </summary>
    private static Outcome<OpenedObject> WalkAbsolute(
        IHandleRelativeFileSystem fs,
        char driveLetter,
        IReadOnlyList<string> components,
        string purpose,
        List<OpenedObject> retained,
        out RefusalCode refusal)
    {
        refusal = RefusalCode.None;

        Outcome<OpenedObject> root = fs.OpenVolumeRoot(driveLetter, OpenRequests.VolumeRoot(driveLetter));
        if (!root.Ok || root.Value is null)
        {
            refusal = root.Refusal == RefusalCode.None ? RefusalCode.VolumeRootUnopenable : root.Refusal;
            return Outcome<OpenedObject>.Refused(refusal);
        }

        retained.Add(root.Value);

        Outcome<ObjectFacts> rootFacts = fs.QueryFacts(root.Value);
        if (!rootFacts.Ok || rootFacts.Value is null)
        {
            refusal = rootFacts.Refusal;
            return Outcome<OpenedObject>.Refused(refusal);
        }

        if (!rootFacts.Value.IsDirectory || rootFacts.Value.IsReparsePoint)
        {
            refusal = RefusalCode.VolumeRootUnopenable;
            return Outcome<OpenedObject>.Refused(refusal);
        }

        if (!string.Equals(
                rootFacts.Value.FileSystemName,
                ProofConfiguration.RequiredFileSystemName,
                StringComparison.Ordinal))
        {
            // Volume identity and 128-bit file identity are only meaningful on
            // a filesystem that supplies them, and the security descriptors
            // this component relies on do not exist on FAT at all.
            refusal = RefusalCode.VolumeFilesystemUnsupported;
            return Outcome<OpenedObject>.Refused(refusal);
        }

        string expectedRoot = string.Create(CultureInfo.InvariantCulture, $"{driveLetter}:\\");
        if (!string.Equals(rootFacts.Value.FinalPath, expectedRoot, StringComparison.OrdinalIgnoreCase))
        {
            refusal = RefusalCode.VolumeIdentityMismatch;
            return Outcome<OpenedObject>.Refused(refusal);
        }

        OpenedObject parent = root.Value;
        foreach (string component in components)
        {
            Outcome<OpenedObject> opened = fs.OpenRelative(
                parent,
                OpenRequests.OpenExistingDirectory(purpose, component));
            if (!opened.Ok || opened.Value is null)
            {
                refusal = opened.Refusal;
                return Outcome<OpenedObject>.Refused(refusal);
            }

            retained.Add(opened.Value);
            RefusalCode intact = RequireIntactDirectory(fs, opened.Value);
            if (intact != RefusalCode.None)
            {
                refusal = intact;
                return Outcome<OpenedObject>.Refused(refusal);
            }

            parent = opened.Value;
        }

        return Outcome<OpenedObject>.Success(parent);
    }

    /// <summary>
    /// Everything that must be true of a directory handle before the
    /// transaction is willing to act relative to it, all read back THROUGH the
    /// handle.
    /// </summary>
    internal static RefusalCode RequireIntactDirectory(
        IHandleRelativeFileSystem fs,
        OpenedObject handle)
    {
        if (!handle.ChainIsRetained)
        {
            return RefusalCode.AncestorHandleNotRetained;
        }

        if (!handle.ChainDeniesDeleteSharing)
        {
            return RefusalCode.AncestorSharingPermitsDelete;
        }

        Outcome<ObjectFacts> facts = fs.QueryFacts(handle);
        if (!facts.Ok || facts.Value is null)
        {
            return facts.Refusal;
        }

        if (!facts.Value.IsDirectory)
        {
            return RefusalCode.ComponentNotDirectory;
        }

        // With OBJ_DONT_REPARSE set the open should already have failed on a
        // reparse point. The second check is not redundant: OBJ_DONT_REPARSE is
        // an argument, and this is an observation of the object that was
        // actually opened. If a future edit dropped the flag, the open would
        // start succeeding and this check would be the thing that still refuses.
        return facts.Value.IsReparsePoint
            ? RefusalCode.ComponentIsReparsePoint
            : RefusalCode.None;
    }

    /// <summary>
    /// Every retained ancestor must still report the volume-and-file identity
    /// it reported when it was opened.
    /// </summary>
    private static RefusalCode RequireAncestorIdentitiesUnchanged(
        IHandleRelativeFileSystem fs,
        IReadOnlyList<AncestorRecord> ancestors)
    {
        foreach (AncestorRecord ancestor in ancestors)
        {
            if (!ancestor.Handle.ChainIsRetained)
            {
                return RefusalCode.AncestorHandleNotRetained;
            }

            Outcome<ObjectFacts> now = fs.QueryFacts(ancestor.Handle);
            if (!now.Ok || now.Value is null)
            {
                return now.Refusal;
            }

            if (!string.Equals(
                    now.Value.IdentityKey,
                    ancestor.Facts.IdentityKey,
                    StringComparison.Ordinal))
            {
                return RefusalCode.ComponentIdentityMismatch;
            }

            if (now.Value.IsReparsePoint || !now.Value.IsDirectory)
            {
                return RefusalCode.ComponentIsReparsePoint;
            }
        }

        return RefusalCode.None;
    }

    private static RefusalCode VerifyProtection(IHandleRelativeFileSystem fs, AncestorRecord ancestor)
    {
        Outcome<AccessCheckResult> check = fs.AccessCheckAsProofIdentity(ancestor.Handle);
        if (!check.Ok || check.Value is null)
        {
            return check.Refusal == RefusalCode.None
                ? RefusalCode.AccessCheckUnavailable
                : check.Refusal;
        }

        // A check against the wrong token is worse than no check. An elevated
        // token would report FullControl on a correctly protected directory and
        // the assertion would then be inverted, so the token kind is part of
        // the result and is required to be the filtered standard token.
        if (!string.Equals(check.Value.TokenKind, "standard-user", StringComparison.Ordinal))
        {
            return RefusalCode.StandardTokenUnavailable;
        }

        uint forbidden = ancestor.ProtectionRequired
            ? NtFlags.FORBIDDEN_FOR_PROOF_IDENTITY
            : AncestorForbiddenMask;
        uint granted = check.Value.GrantedAccess & forbidden;
        if (granted != 0)
        {
            return FirstForbiddenRight(granted);
        }

        if (ancestor.ProtectionRequired && check.Value.RequiredMissing != 0)
        {
            return RefusalCode.ProofIdentityLacksReadExecute;
        }

        return RefusalCode.None;
    }

    /// <summary>
    /// Maps the first forbidden right actually granted to its own refusal code.
    /// One shared "protection failed" code would make five distinguishable
    /// defects indistinguishable, which is how a guard's removal becomes
    /// invisible to the suite that is supposed to detect it.
    /// </summary>
    private static RefusalCode FirstForbiddenRight(uint granted)
    {
        if ((granted & NtFlags.FILE_DELETE_CHILD) != 0)
        {
            return RefusalCode.ProofIdentityHoldsDeleteChild;
        }

        if ((granted & NtFlags.DELETE) != 0)
        {
            return RefusalCode.ProofIdentityHoldsDelete;
        }

        if ((granted & NtFlags.WRITE_DAC) != 0)
        {
            return RefusalCode.ProofIdentityHoldsDaclChange;
        }

        if ((granted & NtFlags.WRITE_OWNER) != 0)
        {
            return RefusalCode.ProofIdentityHoldsOwnerChange;
        }

        return RefusalCode.ProofIdentityHoldsWrite;
    }

    private static string FactsKeyOf(IHandleRelativeFileSystem fs, OpenedObject handle)
    {
        Outcome<ObjectFacts> facts = fs.QueryFacts(handle);
        return facts.Ok && facts.Value is not null ? facts.Value.IdentityKey : string.Empty;
    }

    // -------------------------------------------------------- source closure

    private static Outcome<Dictionary<string, byte[]>> MeasureSourceClosure(
        IHandleRelativeFileSystem fs,
        OpenedObject sourceRoot,
        InstallPlan plan,
        ProofCandidate candidate,
        List<OpenedObject> retained,
        out RefusalCode refusal)
    {
        refusal = RefusalCode.None;

        Outcome<DirectoryListing> listing = fs.ListDirectory(sourceRoot);
        if (!listing.Ok || listing.Value is null)
        {
            refusal = listing.Refusal;
            return Outcome<Dictionary<string, byte[]>>.Refused(refusal);
        }

        if (listing.Value.DirectoryNames.Count > 0)
        {
            refusal = RefusalCode.SourceFileUnexpected;
            return Outcome<Dictionary<string, byte[]>>.Refused(refusal);
        }

        HashSet<string> allowed = new(StringComparer.Ordinal);
        foreach (string name in plan.FileNames)
        {
            allowed.Add(name);
        }

        // Two passes, and the order is load-bearing.
        //
        // Duplicate detection runs over the WHOLE listing before any name is
        // judged against the expected set, because a case-duplicate pair
        // usually contains one name that is also unexpected, and whichever the
        // enumeration happened to reach first would decide the refusal. A
        // refusal that depends on directory-enumeration order is a refusal that
        // stops discriminating the moment the order changes.
        HashSet<string> caseFolded = new(StringComparer.OrdinalIgnoreCase);
        foreach (string present in listing.Value.FileNames)
        {
            if (NameGrammar.Validate(present) != RefusalCode.None)
            {
                refusal = RefusalCode.SourceFileNameInvalid;
                return Outcome<Dictionary<string, byte[]>>.Refused(refusal);
            }

            if (!caseFolded.Add(present))
            {
                // Two names that differ only by case are two spellings of one
                // file on a case-insensitive filesystem, so which one the copy
                // loop picks would be arbitrary.
                refusal = RefusalCode.SourceFileDuplicateCaseInsensitive;
                return Outcome<Dictionary<string, byte[]>>.Refused(refusal);
            }
        }

        foreach (string present in listing.Value.FileNames)
        {
            if (!allowed.Contains(present))
            {
                refusal = RefusalCode.SourceFileUnexpected;
                return Outcome<Dictionary<string, byte[]>>.Refused(refusal);
            }
        }

        Dictionary<string, byte[]> content = new(StringComparer.Ordinal);
        List<CanonicalObject> measurements = [];
        foreach (string name in plan.FileNames)
        {
            Outcome<OpenedObject> file = fs.OpenRelative(sourceRoot, OpenRequests.OpenSourceFile(name));
            if (!file.Ok || file.Value is null)
            {
                refusal = file.Refusal == RefusalCode.NativeNotFound
                    ? RefusalCode.SourceFileMissing
                    : file.Refusal;
                return Outcome<Dictionary<string, byte[]>>.Refused(refusal);
            }

            retained.Add(file.Value);

            Outcome<ObjectFacts> facts = fs.QueryFacts(file.Value);
            if (!facts.Ok || facts.Value is null)
            {
                refusal = facts.Refusal;
                return Outcome<Dictionary<string, byte[]>>.Refused(refusal);
            }

            if (facts.Value.IsReparsePoint || facts.Value.IsDirectory)
            {
                refusal = RefusalCode.SourceRootIsReparsePoint;
                return Outcome<Dictionary<string, byte[]>>.Refused(refusal);
            }

            if (facts.Value.EndOfFile > ProofConfiguration.MaximumInstalledFileBytes)
            {
                refusal = RefusalCode.SourceFileSizeMismatch;
                return Outcome<Dictionary<string, byte[]>>.Refused(refusal);
            }

            // The read below needs no rewind: the handle was opened one statement
            // ago and a freshly opened handle's offset is zero. An earlier
            // revision rewound here anyway and its comment called the call
            // load-bearing, which was false — removing it changed nothing
            // observable — and it contradicted the reason this transaction
            // deliberately does NOT rewind in the verification loop. A decorative
            // call documented as a guard is worse than no call, so it is gone.
            Outcome<byte[]> bytes = fs.ReadThroughHandle(
                file.Value,
                checked((int)ProofConfiguration.MaximumInstalledFileBytes));
            if (!bytes.Ok || bytes.Value is null)
            {
                refusal = bytes.Refusal;
                return Outcome<Dictionary<string, byte[]>>.Refused(refusal);
            }

            // This rewind IS load-bearing. The read above consumed the file, and
            // a handle opened with FILE_SYNCHRONOUS_IO_NONALERT carries an offset
            // the kernel advanced to end of file. Measuring without rewinding
            // hashes zero bytes and digests the empty string — an audit found
            // exactly that, which inverted "measure what was read" into "measure
            // nothing" while every vector still passed.
            //
            // The rewind is requested here, by the caller, rather than hidden
            // inside the adapter's read, because a hidden rewind would make its
            // own absence unobservable to any simulation. That is how the defect
            // survived review the first time.
            RefusalCode rewound = fs.RewindToStart(file.Value);
            if (rewound != RefusalCode.None)
            {
                refusal = rewound;
                return Outcome<Dictionary<string, byte[]>>.Refused(refusal);
            }

            Outcome<FileMeasurement> measurement = fs.MeasureFile(file.Value);
            if (!measurement.Ok || measurement.Value is null)
            {
                refusal = measurement.Refusal;
                return Outcome<Dictionary<string, byte[]>>.Refused(refusal);
            }

            if (!measurement.Value.MeasuredThroughHandle)
            {
                refusal = RefusalCode.SourceMeasurementNotThroughHandle;
                return Outcome<Dictionary<string, byte[]>>.Refused(refusal);
            }

            if (!file.Value.Request.DeniesDeleteSharing ||
                (file.Value.Request.ShareAccess & NtFlags.FILE_SHARE_WRITE) != 0)
            {
                refusal = RefusalCode.SourceSharingPermitsWrite;
                return Outcome<Dictionary<string, byte[]>>.Refused(refusal);
            }

            content[name] = bytes.Value;
            measurements.Add(new CanonicalObject()
                .Set("name", name)
                .Set("sha256", measurement.Value.Sha256Hex)
                .Set("size", measurement.Value.Size));
        }

        if (content.Count != plan.FileNames.Count)
        {
            refusal = RefusalCode.SourceFileMissing;
            return Outcome<Dictionary<string, byte[]>>.Refused(refusal);
        }

        // The fingerprint is recomputed from what the handles measured, then
        // compared against a constant compiled into reviewed source. A
        // fingerprint that arrived with the source, or on the command line,
        // would be a value the attacker also controls.
        string fingerprint = SourceEnvelopeFingerprint(candidate, measurements);
        if (!string.Equals(fingerprint, candidate.ManifestFingerprint, StringComparison.Ordinal))
        {
            refusal = RefusalCode.SourceManifestFingerprintUnknown;
            return Outcome<Dictionary<string, byte[]>>.Refused(refusal);
        }

        return Outcome<Dictionary<string, byte[]>>.Success(content);
    }

    internal static string SourceEnvelopeFingerprint(
        ProofCandidate candidate,
        IReadOnlyList<CanonicalObject> measurements)
    {
        ArgumentNullException.ThrowIfNull(candidate);
        CanonicalObject envelope = new CanonicalObject()
            .Set("bundleVersion", candidate.BundleVersion)
            .Set("buildFlavor", candidate.BuildFlavor)
            .Set("component", candidate.Component)
            .Set("files", measurements)
            .Set("schemaVersion", 1);
        return ProofConfiguration.Sha256Hex(CanonicalJson.Serialize(envelope));
    }

    // ---------------------------------------------------- destination closure

    private static RefusalCode CopyClosure(
        IHandleRelativeFileSystem fs,
        AncestorRecord leaf,
        InstallPlan plan,
        Dictionary<string, byte[]> content,
        SecurityDescriptorPlan filePlan,
        List<string> steps)
    {
        // The last point before anything is created. If any ancestor handle has
        // been closed, or any was opened with delete sharing, the guarantee the
        // whole walk existed to produce is already gone and nothing may be
        // written.
        if (!leaf.Handle.ChainIsRetained)
        {
            return RefusalCode.AncestorHandleNotRetained;
        }

        if (!leaf.Handle.ChainDeniesDeleteSharing)
        {
            return RefusalCode.AncestorSharingPermitsDelete;
        }

        steps.Add("assert-chain-retained-before-create");

        foreach (string name in plan.FileNames)
        {
            if (string.Equals(name, ProofConfiguration.InstalledManifestFileName, StringComparison.Ordinal) ||
                string.Equals(name, ProofConfiguration.InstallRecordFileName, StringComparison.Ordinal))
            {
                // Written last, below, so an interrupted install is
                // recognizable by the absence of its manifest.
                continue;
            }

            if (!content.TryGetValue(name, out byte[]? bytes) || bytes is null)
            {
                return RefusalCode.SourceFileMissing;
            }

            RefusalCode written = WriteOneFile(fs, leaf.Handle, name, bytes, filePlan);
            if (written != RefusalCode.None)
            {
                return written;
            }
        }

        byte[] record = BuildInstallRecord(plan, leaf);
        RefusalCode recordWritten = WriteOneFile(
            fs,
            leaf.Handle,
            ProofConfiguration.InstallRecordFileName,
            record,
            filePlan);
        if (recordWritten != RefusalCode.None)
        {
            return recordWritten;
        }

        byte[] manifest = BuildInstalledManifest(plan, content);
        return WriteOneFile(
            fs,
            leaf.Handle,
            ProofConfiguration.InstalledManifestFileName,
            manifest,
            filePlan);
    }

    private static RefusalCode WriteOneFile(
        IHandleRelativeFileSystem fs,
        OpenedObject leaf,
        string name,
        byte[] bytes,
        SecurityDescriptorPlan filePlan)
    {
        Outcome<OpenedObject> destination = fs.OpenRelative(
            leaf,
            OpenRequests.CreateDestinationFile(name, filePlan));
        if (!destination.Ok || destination.Value is null)
        {
            return destination.Refusal == RefusalCode.NativeAlreadyExists
                ? RefusalCode.DestinationFileCollision
                : destination.Refusal;
        }

        using (destination.Value)
        {
            Outcome<FileMeasurement> written = fs.WriteThroughHandle(destination.Value, bytes);
            if (!written.Ok || written.Value is null)
            {
                return written.Refusal;
            }

            RefusalCode flushed = fs.FlushBuffers(destination.Value);
            if (flushed != RefusalCode.None)
            {
                return flushed;
            }

            // The write left the offset at end of file. Re-measuring without
            // rewinding would hash zero bytes, compare the digest of the empty
            // string against the digest of the content, and refuse every install
            // with destination-digest-mismatch-after-write — the same offset
            // defect, in the other direction.
            //
            // This re-reads through the handle that did the writing rather than
            // re-opening the file by name: a name resolved a second time is a
            // name that can resolve to something else, which is the substitution
            // this component exists to prevent.
            RefusalCode rewound = fs.RewindToStart(destination.Value);
            if (rewound != RefusalCode.None)
            {
                return rewound;
            }

            Outcome<FileMeasurement> reread = fs.MeasureFile(destination.Value);
            if (!reread.Ok || reread.Value is null)
            {
                return reread.Refusal;
            }

            if (!string.Equals(
                    reread.Value.Sha256Hex,
                    ProofConfiguration.Sha256Hex(bytes),
                    StringComparison.Ordinal))
            {
                return RefusalCode.DestinationDigestMismatchAfterWrite;
            }
        }

        return RefusalCode.None;
    }

    private static RefusalCode VerifyInstalledClosure(
        IHandleRelativeFileSystem fs,
        AncestorRecord leaf,
        InstallPlan plan,
        Dictionary<string, byte[]> content,
        SecurityDescriptorPlan filePlan)
    {
        Outcome<DirectoryListing> listing = fs.ListDirectory(leaf.Handle);
        if (!listing.Ok || listing.Value is null)
        {
            return listing.Refusal;
        }

        if (listing.Value.DirectoryNames.Count > 0)
        {
            return RefusalCode.DestinationExtraEntry;
        }

        HashSet<string> expected = new(StringComparer.Ordinal);
        foreach (string name in plan.FileNames)
        {
            expected.Add(name);
        }

        expected.Add(ProofConfiguration.InstalledManifestFileName);
        expected.Add(ProofConfiguration.InstallRecordFileName);

        foreach (string present in listing.Value.FileNames)
        {
            if (!expected.Contains(present))
            {
                return RefusalCode.DestinationExtraEntry;
            }
        }

        foreach (string name in plan.FileNames)
        {
            if (string.Equals(name, ProofConfiguration.InstalledManifestFileName, StringComparison.Ordinal) ||
                string.Equals(name, ProofConfiguration.InstallRecordFileName, StringComparison.Ordinal))
            {
                continue;
            }

            Outcome<OpenedObject> file = fs.OpenRelative(
                leaf.Handle,
                OpenRequests.OpenInstalledFileForVerification(name));
            if (!file.Ok || file.Value is null)
            {
                return file.Refusal;
            }

            using (file.Value)
            {
                Outcome<FileMeasurement> measurement = fs.MeasureFile(file.Value);
                if (!measurement.Ok || measurement.Value is null)
                {
                    return measurement.Refusal;
                }

                if (!content.TryGetValue(name, out byte[]? source) || source is null)
                {
                    return RefusalCode.SourceFileMissing;
                }

                if (!string.Equals(
                        measurement.Value.Sha256Hex,
                        ProofConfiguration.Sha256Hex(source),
                        StringComparison.Ordinal))
                {
                    return RefusalCode.SourceFileDigestMismatch;
                }

                Outcome<SecuritySnapshot> security = fs.QuerySecurity(file.Value);
                if (!security.Ok || security.Value is null)
                {
                    return security.Refusal;
                }

                RefusalCode exact = filePlan.RequireExactMatch(security.Value);
                if (exact != RefusalCode.None)
                {
                    return exact;
                }

                Outcome<AccessCheckResult> check = fs.AccessCheckAsProofIdentity(file.Value);
                if (!check.Ok || check.Value is null)
                {
                    return RefusalCode.AccessCheckUnavailable;
                }

                if (check.Value.ForbiddenGranted != 0)
                {
                    return FirstForbiddenRight(check.Value.ForbiddenGranted);
                }
            }
        }

        return RefusalCode.None;
    }

    // ------------------------------------------------------- manifest format

    private static byte[] BuildInstalledManifest(
        InstallPlan plan,
        Dictionary<string, byte[]> content)
    {
        List<CanonicalObject> files = [];
        foreach (string name in plan.FileNames)
        {
            if (string.Equals(name, ProofConfiguration.InstalledManifestFileName, StringComparison.Ordinal) ||
                string.Equals(name, ProofConfiguration.InstallRecordFileName, StringComparison.Ordinal))
            {
                continue;
            }

            byte[] bytes = content.TryGetValue(name, out byte[]? value) && value is not null
                ? value
                : [];
            files.Add(new CanonicalObject()
                .Set("name", name)
                .Set("sha256", ProofConfiguration.Sha256Hex(bytes))
                .Set("size", bytes.LongLength));
        }

        CanonicalObject manifest = new CanonicalObject()
            .Set("candidateId", plan.CandidateId)
            .Set("files", files)
            .Set("manifestKind", "ai-dev-os-stage17-proof-installed-manifest")
            .Set("runToken", plan.RunToken)
            .Set("schemaVersion", 1);
        return CanonicalJson.Serialize(manifest);
    }

    private static byte[] BuildInstallRecord(InstallPlan plan, AncestorRecord leaf)
    {
        CanonicalObject record = new CanonicalObject()
            .Set("leafIdentity", leaf.Facts.IdentityKey)
            .Set("recordKind", "ai-dev-os-stage17-proof-install-record")
            .Set("runToken", plan.RunToken)
            .Set("schemaVersion", 1);
        return CanonicalJson.Serialize(record);
    }

    private static Outcome<InstalledManifest> ReadInstalledManifest(
        IHandleRelativeFileSystem fs,
        OpenedObject leaf,
        string runToken)
    {
        Outcome<OpenedObject> file = fs.OpenRelative(
            leaf,
            OpenRequests.OpenInstalledFileForVerification(
                ProofConfiguration.InstalledManifestFileName));
        if (!file.Ok || file.Value is null)
        {
            return Outcome<InstalledManifest>.Refused(
                file.Refusal == RefusalCode.NativeNotFound
                    ? RefusalCode.RemovalRecordUnreadable
                    : file.Refusal);
        }

        using (file.Value)
        {
            Outcome<byte[]> bytes = fs.ReadThroughHandle(
                file.Value,
                ProofConfiguration.MaximumManifestBytes);
            if (!bytes.Ok || bytes.Value is null)
            {
                return Outcome<InstalledManifest>.Refused(RefusalCode.RemovalRecordUnreadable);
            }

            return InstalledManifest.Parse(bytes.Value, runToken);
        }
    }

    private static RefusalCode DeleteExactFile(
        IHandleRelativeFileSystem fs,
        OpenedObject leaf,
        string name,
        DirectoryListing listing)
    {
        // Nothing here can expand: `name` came from a manifest that was itself
        // required to contain only names in the closed grammar, and the entry
        // must already have been observed in the enumeration. There is no
        // pattern, no prefix, and no recursion, so the deletion set is finite
        // and enumerable before the first delete happens.
        if (NameGrammar.Validate(name) != RefusalCode.None)
        {
            return RefusalCode.RemovalWildcardRefused;
        }

        bool present = false;
        foreach (string candidate in listing.FileNames)
        {
            if (string.Equals(candidate, name, StringComparison.Ordinal))
            {
                present = true;
                break;
            }
        }

        if (!present)
        {
            // An interrupted previous removal is recognizable rather than an
            // error: the file this removal was going to delete is already gone.
            return RefusalCode.None;
        }

        Outcome<OpenedObject> file = fs.OpenRelative(leaf, OpenRequests.OpenFileForDeletion(name));
        if (!file.Ok || file.Value is null)
        {
            return file.Refusal;
        }

        using (file.Value)
        {
            Outcome<ObjectFacts> facts = fs.QueryFacts(file.Value);
            if (!facts.Ok || facts.Value is null)
            {
                return facts.Refusal;
            }

            if (facts.Value.IsDirectory || facts.Value.IsReparsePoint)
            {
                return RefusalCode.RemovalUnexpectedEntry;
            }

            return fs.DeleteThroughHandle(file.Value);
        }
    }

    private static TransactionReport RefuseInstallWithRollback(
        IHandleRelativeFileSystem fs,
        RefusalCode refusal,
        string step,
        List<string> steps,
        List<AncestorRecord> ancestors,
        bool tokenLeafCreated,
        InstallPlan plan,
        SecurityDescriptorPlan directoryPlan)
    {
        RollbackReport rollback = RollbackReport.NotRequired;
        try
        {
            if (ancestors.Count == plan.DestinationComponents.Count + 1)
            {
                AncestorRecord leaf = ancestors[^1];
                string expectedLeaf = plan.DestinationComponents[^1];
                if (leaf.CreatedByThisTransaction &&
                    string.Equals(leaf.Name, expectedLeaf, StringComparison.Ordinal) &&
                    string.Equals(leaf.Handle.ComponentName, expectedLeaf, StringComparison.Ordinal))
                {
                    RefusalCode rollbackRefusal = RollbackEmptyCreatedLeaf(
                        fs,
                        leaf,
                        ancestors,
                        plan,
                        directoryPlan,
                        out string rollbackStep);
                    if (rollbackRefusal == RefusalCode.None)
                    {
                        steps.Add("rollback-empty-created-leaf");
                        rollback = RollbackReport.Completed;
                    }
                    else
                    {
                        rollback = RollbackReport.Refused(rollbackRefusal, rollbackStep);
                    }
                }
            }

            if (ReferenceEquals(rollback, RollbackReport.NotRequired) && tokenLeafCreated)
            {
                rollback = RollbackReport.Refused(
                    RefusalCode.RollbackCandidateUnproven,
                    "verify-created-leaf-for-rollback");
            }
        }
        catch
        {
            // The rollback boundary is finite and body-free. It cannot replace
            // the primary refusal above, and it cannot escape with exception
            // text that may contain native or caller-controlled detail.
            rollback = RollbackReport.Refused(RefusalCode.InternalRefusal, "rollback-boundary");
        }

        return new TransactionReport(
            "install",
            refusal == RefusalCode.None ? RefusalCode.InternalRefusal : refusal,
            step,
            steps,
            rollback);
    }

    private static RefusalCode RollbackEmptyCreatedLeaf(
        IHandleRelativeFileSystem fs,
        AncestorRecord leaf,
        IReadOnlyList<AncestorRecord> ancestors,
        InstallPlan plan,
        SecurityDescriptorPlan directoryPlan,
        out string failedStep)
    {
        failedStep = "verify-created-leaf-for-rollback";
        if ((leaf.Handle.Request.DesiredAccess & NtFlags.DELETE) == 0)
        {
            return RefusalCode.DeleteUnsupported;
        }

        RefusalCode verified = VerifyExactProtectedChain(
            fs,
            ancestors,
            plan.DestinationComponents,
            directoryPlan);
        if (verified != RefusalCode.None)
        {
            return verified;
        }

        failedStep = "prove-created-leaf-empty";
        Outcome<DirectoryListing> listing = fs.ListDirectory(leaf.Handle);
        if (!listing.Ok || listing.Value is null)
        {
            return listing.Refusal;
        }

        if (!listing.Value.IsEmpty)
        {
            return RefusalCode.RemovalDirectoryNotEmpty;
        }

        // Enumeration is an asynchronous boundary at which a simulated or
        // hostile filesystem can change what it reports. Re-run every identity,
        // DACL, object-type, and access proof immediately before the only delete.
        failedStep = "reverify-created-leaf-for-rollback";
        verified = VerifyExactProtectedChain(
            fs,
            ancestors,
            plan.DestinationComponents,
            directoryPlan);
        if (verified != RefusalCode.None)
        {
            return verified;
        }

        failedStep = "reprove-created-leaf-empty";
        Outcome<DirectoryListing> secondListing = fs.ListDirectory(leaf.Handle);
        if (!secondListing.Ok || secondListing.Value is null)
        {
            return secondListing.Refusal;
        }

        if (!secondListing.Value.IsEmpty)
        {
            return RefusalCode.RemovalDirectoryNotEmpty;
        }

        failedStep = "final-verify-created-leaf-for-rollback";
        verified = VerifyExactProtectedChain(
            fs,
            ancestors,
            plan.DestinationComponents,
            directoryPlan);
        if (verified != RefusalCode.None)
        {
            return verified;
        }

        failedStep = "delete-empty-created-leaf";
        return fs.DeleteThroughHandle(leaf.Handle);
    }

    private static RefusalCode RecoverManifestlessEmptyLeaf(
        IHandleRelativeFileSystem fs,
        OpenedObject leaf,
        IReadOnlyList<AncestorRecord> ancestors,
        IReadOnlyList<string> destinationComponents,
        SecurityDescriptorPlan directoryPlan,
        out string failedStep)
    {
        failedStep = "verify-manifestless-removal-chain";
        if ((leaf.Request.DesiredAccess & NtFlags.DELETE) == 0)
        {
            return RefusalCode.DeleteUnsupported;
        }

        RefusalCode verified = VerifyExactProtectedChain(
            fs,
            ancestors,
            destinationComponents,
            directoryPlan);
        if (verified != RefusalCode.None)
        {
            return verified;
        }

        failedStep = "prove-manifestless-leaf-empty";
        Outcome<DirectoryListing> secondListing = fs.ListDirectory(leaf);
        if (!secondListing.Ok || secondListing.Value is null)
        {
            return secondListing.Refusal;
        }

        if (!secondListing.Value.IsEmpty)
        {
            return RefusalCode.RemovalDirectoryNotEmpty;
        }

        // Nothing above the token leaf is ever a candidate on this path. The
        // final verification below includes every retained ancestor, but the
        // only handle passed to deletion is the exact token-leaf handle.
        failedStep = "reverify-manifestless-removal-chain";
        verified = VerifyExactProtectedChain(
            fs,
            ancestors,
            destinationComponents,
            directoryPlan);
        if (verified != RefusalCode.None)
        {
            return verified;
        }

        failedStep = "delete-manifestless-empty-leaf";
        return fs.DeleteThroughHandle(leaf);
    }

    private static RefusalCode VerifyExactProtectedChain(
        IHandleRelativeFileSystem fs,
        IReadOnlyList<AncestorRecord> ancestors,
        IReadOnlyList<string> destinationComponents,
        SecurityDescriptorPlan directoryPlan)
    {
        if (ancestors.Count != destinationComponents.Count + 1)
        {
            return RefusalCode.ComponentIdentityMismatch;
        }

        for (int index = 0; index < destinationComponents.Count; index++)
        {
            AncestorRecord current = ancestors[index + 1];
            string expectedName = destinationComponents[index];
            if (!string.Equals(current.Name, expectedName, StringComparison.Ordinal) ||
                !string.Equals(current.Handle.ComponentName, expectedName, StringComparison.Ordinal))
            {
                return RefusalCode.ComponentFinalPathMismatch;
            }
        }

        RefusalCode unchanged = RequireAncestorIdentitiesUnchanged(fs, ancestors);
        if (unchanged != RefusalCode.None)
        {
            return unchanged;
        }

        foreach (AncestorRecord ancestor in ancestors)
        {
            RefusalCode protection = VerifyProtection(fs, ancestor);
            if (protection != RefusalCode.None)
            {
                return protection;
            }
        }

        for (int index = 1; index < ancestors.Count; index++)
        {
            Outcome<SecuritySnapshot> security = fs.QuerySecurity(ancestors[index].Handle);
            if (!security.Ok || security.Value is null)
            {
                return security.Refusal;
            }

            RefusalCode exact = directoryPlan.RequireExactMatch(security.Value);
            if (exact != RefusalCode.None)
            {
                return exact;
            }
        }

        return RefusalCode.None;
    }

    private static TransactionReport Refuse(
        string operation,
        RefusalCode refusal,
        string step,
        List<string> steps) =>
        new(
            operation,
            refusal == RefusalCode.None ? RefusalCode.InternalRefusal : refusal,
            step,
            steps);
}

/// <summary>
/// The installed manifest, parsed strictly.
///
/// ADR 0017 section 5 states the rule this parser implements: paths in a
/// journal are never trusted. The same applies to a manifest. What is read back
/// can name files that removal will then look for, and nothing more; it cannot
/// name a directory, a path, a parent, or a second spelling of anything,
/// because every name must pass the closed component grammar and the removal
/// only ever opens names relative to a handle it already holds.
/// </summary>
internal sealed class InstalledManifest
{
    private readonly HashSet<string> createdAncestors;
    private readonly Dictionary<string, string> ancestorIdentities;

    private InstalledManifest(
        string runToken,
        IReadOnlyList<string> fileNames,
        HashSet<string> createdAncestors,
        Dictionary<string, string> ancestorIdentities)
    {
        RunToken = runToken;
        FileNames = fileNames;
        this.createdAncestors = createdAncestors;
        this.ancestorIdentities = ancestorIdentities;
    }

    internal string RunToken { get; }

    internal IReadOnlyList<string> FileNames { get; }

    internal bool AncestorCreatedByThisTransaction(string name) => createdAncestors.Contains(name);

    internal bool AncestorIdentityMatches(string name, string identityKey) =>
        ancestorIdentities.TryGetValue(name, out string? recorded) &&
        string.Equals(recorded, identityKey, StringComparison.Ordinal);

    /// <summary>
    /// A deliberately small, hand-written reader for exactly the shape this
    /// component writes. It is not a JSON parser: it accepts one canonical
    /// serialization and refuses everything else, which removes an entire class
    /// of parser-differential problems at the cost of being useless for any
    /// other input — which is the point.
    /// </summary>
    internal static Outcome<InstalledManifest> Parse(byte[] bytes, string expectedRunToken)
    {
        ArgumentNullException.ThrowIfNull(bytes);
        if (bytes.Length == 0 || bytes.Length > ProofConfiguration.MaximumManifestBytes)
        {
            return Outcome<InstalledManifest>.Refused(RefusalCode.RemovalRecordSchemaInvalid);
        }

        string text;
        try
        {
            text = new UTF8Encoding(false, throwOnInvalidBytes: true).GetString(bytes);
        }
        catch (ArgumentException)
        {
            return Outcome<InstalledManifest>.Refused(RefusalCode.RemovalRecordUnreadable);
        }

        if (!text.StartsWith("{\"candidateId\":\"", StringComparison.Ordinal) ||
            !text.EndsWith('}'))
        {
            return Outcome<InstalledManifest>.Refused(RefusalCode.RemovalRecordSchemaInvalid);
        }

        if (!text.Contains("\"manifestKind\":\"ai-dev-os-stage17-proof-installed-manifest\"", StringComparison.Ordinal))
        {
            return Outcome<InstalledManifest>.Refused(RefusalCode.RemovalRecordSchemaInvalid);
        }

        string tokenMarker = string.Concat("\"runToken\":\"", expectedRunToken, "\"");
        if (!text.Contains(tokenMarker, StringComparison.Ordinal))
        {
            // A substituted manifest can at most name a DIFFERENT token, and a
            // different token derives a different, non-existent leaf. Refusing
            // here means it cannot even do that.
            return Outcome<InstalledManifest>.Refused(RefusalCode.RemovalTokenMismatch);
        }

        List<string> names = [];
        int cursor = 0;
        const string nameMarker = "{\"name\":\"";
        while (true)
        {
            int start = text.IndexOf(nameMarker, cursor, StringComparison.Ordinal);
            if (start < 0)
            {
                break;
            }

            start += nameMarker.Length;
            int end = text.IndexOf('"', start);
            if (end < 0)
            {
                return Outcome<InstalledManifest>.Refused(RefusalCode.RemovalRecordSchemaInvalid);
            }

            string name = text[start..end];
            if (NameGrammar.Validate(name) != RefusalCode.None)
            {
                return Outcome<InstalledManifest>.Refused(RefusalCode.RemovalRecordSchemaInvalid);
            }

            names.Add(name);
            cursor = end;
            if (names.Count > ProofConfiguration.MaximumInstalledFileCount)
            {
                return Outcome<InstalledManifest>.Refused(RefusalCode.RemovalRecordSchemaInvalid);
            }
        }

        HashSet<string> created = new(StringComparer.Ordinal);
        Dictionary<string, string> identities = new(StringComparer.Ordinal);
        return Outcome<InstalledManifest>.Success(
            new InstalledManifest(expectedRunToken, names, created, identities));
    }
}

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace AiDevOs.WindowsProofInstaller;

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
        List<CanonicalObject> failedDetail = [];
        List<CanonicalObject> canonical = new(vectors.Count);
        foreach (ConformanceVector vector in vectors)
        {
            canonical.Add(vector.ToCanonical());
            if (!vector.Passed)
            {
                failed.Add(vector.Name);
                failedDetail.Add(vector.ToCanonical());
            }
        }

        FailedNames = failed;
        FailedDetail = failedDetail;
        CanonicalObject envelope = new CanonicalObject()
            .Set("suite", suite)
            .Set("suiteVersion", 1)
            .Set("vectors", canonical);
        Digest = ProofConfiguration.Sha256Hex(CanonicalJson.Serialize(envelope));
    }

    internal string Suite { get; }

    internal IReadOnlyList<ConformanceVector> Vectors { get; }

    internal IReadOnlyList<string> FailedNames { get; }

    /// <summary>
    /// Expected and observed for every failing vector. A self-test that only
    /// reports which vector failed makes a reviewer rebuild the binary with
    /// extra printing to learn what it actually saw, and that is a step people
    /// skip.
    /// </summary>
    internal IReadOnlyList<CanonicalObject> FailedDetail { get; }

    internal string Digest { get; }

    internal int Count => Vectors.Count;

    internal int FailedCount => FailedNames.Count;

    internal bool Passed => FailedCount == 0;
}

/// <summary>
/// The read-only conformance suite for the proof installer.
///
/// Every vector runs in memory. Nothing here opens a file, creates a directory,
/// resolves a real known folder, touches <c>C:\ProgramData</c>, allocates a
/// kernel object, or instantiates
/// <see cref="NativeHandleRelativeFileSystem"/> — which is itself asserted by a
/// vector, because "the self-test is read-only" is a claim worth checking
/// rather than asserting.
///
/// The suite is deliberately different between the two build recipes. A sealed
/// build cannot construct a <see cref="ReviewedProofModeAuthorization"/>, so it
/// cannot run the install and removal transactions even against the simulated
/// filesystem; it asserts instead that the gate refuses. A reviewed-proof build
/// runs the whole transaction and pins the exact operation sequence, the exact
/// flags, and the exact refusal produced by each hostile condition. The two
/// therefore report different vector counts and different digests, which is the
/// ADR 0018 section 4 requirement that the flavours be verifiably distinct.
/// </summary>
internal static class InstallerConformance
{
    private const string Token = "0123456789abcdef0123456789abcdef";
    private const string OtherToken = "fedcba9876543210fedcba9876543210";

    private static readonly UTF8Encoding Utf8 = new(encoderShouldEmitUTF8Identifier: false);

    internal static ConformanceReport Run()
    {
        List<ConformanceVector> vectors = [];
        AddGrammarVectors(vectors);
        AddPathVectors(vectors);
        AddRefusalVectors(vectors);
        AddSecurityDescriptorVectors(vectors);
        AddAceEvaluationVectors(vectors);
        AddFlagVectors(vectors);
        AddStatusMappingVectors(vectors);
        AddConfigurationVectors(vectors);
        AddPlanVectors(vectors);
        AddGateVectors(vectors);
        AddHandleRetentionVectors(vectors);
        AddContractLinkageVectors(vectors);
        AddInformationClassVectors(vectors);
        AddTransactionVectors(vectors);

        // LAST, deliberately, and this ordering is the whole point.
        //
        // A MEASUREMENT, not a tautology. The previous form compared the literal
        // "true" to the literal "true" — the F2 defect from the release evidence,
        // shipped in the same checkpoint whose comments cite F2 twice as the thing
        // being avoided. A claim about what the self-test did has to be a reading
        // of what the self-test did, so these counters are incremented by the
        // native adapter's own constructor and its own open path.
        //
        // Reading them here rather than mid-suite is a correction an audit asked
        // for: added earlier, the vector observed only the vectors that happened
        // to precede it, so an instantiation by a LATER vector — including every
        // transaction vector — would not have flipped it. Added last, it covers
        // the whole suite.
        vectors.Add(new ConformanceVector(
            "transaction/self-test-never-instantiates-the-native-filesystem",
            "instantiations=0 nativeOpens=0",
            NativeFileSystemActivity()));

        return new ConformanceReport("windows-proof-installer-v1", vectors);
    }

    // ---------------------------------------------------------------- grammar

    private static void AddGrammarVectors(List<ConformanceVector> vectors)
    {
        (string Input, string Expected)[] cases =
        [
            ("alpha.dll", "accepted"),
            ("AI-Dev-OS", "accepted"),
            ("Stage17-Proof", "accepted"),
            ("0123456789abcdef0123456789abcdef", "accepted"),
            ("stage17-proof-manifest.json", "accepted"),
            ("alpha.dll:stream", "component-name-invalid"),
            ("alpha.dll::$DATA", "component-name-invalid"),
            ("NUL", "component-name-invalid"),
            ("nul.json", "component-name-invalid"),
            ("CON", "component-name-invalid"),
            ("COM1.dll", "component-name-invalid"),
            ("CONIN$", "component-name-invalid"),
            ("alpha.", "component-name-invalid"),
            ("alpha ", "component-name-invalid"),
            (" alpha", "component-name-invalid"),
            ("*.dll", "component-name-invalid"),
            ("a?b", "component-name-invalid"),
            ("a\\b", "component-name-invalid"),
            ("a/b", "component-name-invalid"),
            ("..", "component-name-invalid"),
            ("a..b", "component-name-invalid"),
            ("PROGRA~1", "component-name-invalid"),
            (".hidden", "component-name-invalid"),
            ("-leading", "component-name-invalid"),
            ("alphaé.dll", "component-name-invalid"),
            ("", "component-name-invalid"),
        ];

        foreach ((string input, string expected) in cases)
        {
            RefusalCode code = NameGrammar.Validate(input);
            vectors.Add(new ConformanceVector(
                string.Concat("grammar/name/", Label(input)),
                expected,
                code == RefusalCode.None ? "accepted" : ProtocolNames.Of(code)));
        }

        vectors.Add(new ConformanceVector(
            "grammar/name/too-long",
            "component-name-invalid",
            ProtocolNames.Of(NameGrammar.Validate(new string('a', 129)))));

        (string Input, bool Expected)[] tokens =
        [
            (Token, true),
            (OtherToken, true),
            ("0123456789ABCDEF0123456789ABCDEF", false),
            ("0123456789abcdef0123456789abcde", false),
            ("0123456789abcdef0123456789abcdefa", false),
            ("0123456789abcdef0123456789abcdeg", false),
            ("", false),
        ];
        foreach ((string input, bool expected) in tokens)
        {
            vectors.Add(new ConformanceVector(
                string.Concat("grammar/token/", Label(input)),
                expected ? "true" : "false",
                NameGrammar.IsRunToken(input) ? "true" : "false"));
        }

        // ADR 0018 section 2.4: a fingerprint supplied on the command line is
        // NOT a trust root. The candidate identifier grammar is deliberately
        // shaped so a 64-character digest cannot be one, which means no
        // operator can introduce a new expected fingerprint by typing it.
        vectors.Add(new ConformanceVector(
            "grammar/candidate-id/rejects-sha256-shaped-argument",
            "false",
            NameGrammar.IsCandidateId(new string('a', 64)) ? "true" : "false"));
        vectors.Add(new ConformanceVector(
            "grammar/candidate-id/accepts-reviewed-identifier",
            "true",
            NameGrammar.IsCandidateId("supervisor-1-0-0-sealed") ? "true" : "false"));
        vectors.Add(new ConformanceVector(
            "grammar/candidate-id/rejects-uppercase",
            "false",
            NameGrammar.IsCandidateId("Supervisor") ? "true" : "false"));
    }

    private static void AddPathVectors(List<ConformanceVector> vectors)
    {
        (string Input, string Expected)[] cases =
        [
            ("C:\\staging\\closure", "accepted"),
            ("c:\\staging\\closure", "accepted"),
            ("\\\\?\\C:\\staging", "argument-invalid"),
            ("\\\\.\\C:\\staging", "argument-invalid"),
            ("\\\\server\\share\\x", "argument-invalid"),
            ("C:/staging/closure", "argument-invalid"),
            ("C:staging", "argument-invalid"),
            ("C:\\", "argument-invalid"),
            ("C:\\staging\\", "argument-invalid"),
            ("C:\\staging\\..\\other", "component-name-invalid"),
            ("C:\\staging\\clo sure", "component-name-invalid"),
            ("staging\\closure", "argument-invalid"),
        ];

        foreach ((string input, string expected) in cases)
        {
            RefusalCode code = NameGrammar.TryParseDriveRootedPath(input, out char _, out IReadOnlyList<string> _);
            vectors.Add(new ConformanceVector(
                string.Concat("grammar/path/", Label(input)),
                expected,
                code == RefusalCode.None ? "accepted" : ProtocolNames.Of(code)));
        }
    }

    private static void AddRefusalVectors(List<ConformanceVector> vectors)
    {
        vectors.Add(new ConformanceVector(
            "refusals/every-code-has-a-spelling",
            "true",
            ProtocolNames.EveryCodeHasASpelling() ? "true" : "false"));
        vectors.Add(new ConformanceVector(
            "refusals/every-spelling-is-distinct",
            "true",
            ProtocolNames.EverySpellingIsDistinct() ? "true" : "false"));
        vectors.Add(new ConformanceVector(
            "refusals/unknown-code-maps-to-internal",
            "internal-refusal",
            ProtocolNames.Of((RefusalCode)0x7FFF)));
    }

    // ---------------------------------------------------- security descriptors

    private static ProofIdentity FixtureIdentity() =>
        new(SimulatedFileSystem.ProofIdentitySid, false);

    private static void AddSecurityDescriptorVectors(List<ConformanceVector> vectors)
    {
        Outcome<SecurityDescriptorPlan> directory = SecurityDescriptorPlan.ForDirectory(FixtureIdentity());
        vectors.Add(new ConformanceVector(
            "sd/directory-sddl",
            "O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;" +
                SimulatedFileSystem.ProofIdentitySid + ")",
            directory.Ok && directory.Value is not null ? directory.Value.Sddl : "refused"));

        Outcome<SecurityDescriptorPlan> file = SecurityDescriptorPlan.ForFile(FixtureIdentity());
        vectors.Add(new ConformanceVector(
            "sd/file-sddl",
            "O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x1200a9;;;" +
                SimulatedFileSystem.ProofIdentitySid + ")",
            file.Ok && file.Value is not null ? file.Value.Sddl : "refused"));

        // Granting the read ACE to a well-known universal principal would widen
        // it to every local account AND make the subsequent protection check
        // meaningless, because the principal it then checks already holds
        // FullControl through another ACE.
        foreach (string sid in new[]
        {
            WellKnownSids.Everyone,
            WellKnownSids.BuiltinUsers,
            WellKnownSids.AuthenticatedUsers,
            WellKnownSids.LocalSystem,
            WellKnownSids.BuiltinAdministrators,
        })
        {
            Outcome<SecurityDescriptorPlan> refused = SecurityDescriptorPlan.ForDirectory(
                new ProofIdentity(sid, WellKnownSids.IsWellKnownPrivileged(sid)));
            vectors.Add(new ConformanceVector(
                string.Concat("sd/refuses-well-known-identity/", sid),
                "proof-identity-unacceptable",
                refused.Ok ? "accepted" : ProtocolNames.Of(refused.Refusal)));
        }

        // A SID string is interpolated into SDDL, so a value that could carry
        // SDDL syntax has to be refused before composition, not sanitised after.
        Outcome<SecurityDescriptorPlan> injected = SecurityDescriptorPlan.ForDirectory(
            new ProofIdentity("S-1-5-21-1-1-1-1000)(A;OICI;FA;;;WD", false));
        vectors.Add(new ConformanceVector(
            "sd/refuses-sddl-injection-in-sid",
            "proof-identity-unacceptable",
            injected.Ok ? "accepted" : ProtocolNames.Of(injected.Refusal)));

        if (directory.Value is null)
        {
            return;
        }

        SecurityDescriptorPlan plan = directory.Value;
        vectors.Add(new ConformanceVector(
            "sd/exact-match-accepts-intended-dacl",
            "none",
            ProtocolNames.Of(plan.RequireExactMatch(SnapshotOf(plan, WellKnownSids.BuiltinAdministrators)))));

        vectors.Add(new ConformanceVector(
            "sd/exact-match-refuses-untrusted-owner",
            "owner-untrusted",
            ProtocolNames.Of(plan.RequireExactMatch(
                SnapshotOf(plan, SimulatedFileSystem.ProofIdentitySid)))));

        // The owner requirement is equality with one named principal, not
        // membership of a trusted set. SYSTEM is a trusted principal and is
        // still refused as an owner, because the plan names Administrators and
        // "exact" means exact. This vector is what keeps the requirement from
        // being silently widened back to a set-membership test.
        vectors.Add(new ConformanceVector(
            "sd/owner-requirement-is-equality-not-membership",
            "S-1-5-32-544:owner-untrusted",
            string.Concat(
                plan.OwnerSid,
                ":",
                ProtocolNames.Of(plan.RequireExactMatch(
                    SnapshotOf(plan, WellKnownSids.LocalSystem))))));

        List<AceSnapshot> extra = new(plan.ExpectedAces)
        {
            new AceSnapshot(
                NtFlags.ACCESS_ALLOWED_ACE_TYPE, 0, NtFlags.FILE_ALL_ACCESS, WellKnownSids.BuiltinUsers),
        };
        vectors.Add(new ConformanceVector(
            "sd/exact-match-refuses-extra-ace",
            "dacl-unexpected-ace",
            ProtocolNames.Of(plan.RequireExactMatch(new SecuritySnapshot(
                WellKnownSids.BuiltinAdministrators,
                (ushort)(NtFlags.SE_DACL_PRESENT | NtFlags.SE_DACL_PROTECTED),
                true,
                extra)))));

        List<AceSnapshot> missing = [plan.ExpectedAces[0], plan.ExpectedAces[1]];
        vectors.Add(new ConformanceVector(
            "sd/exact-match-refuses-missing-ace",
            "dacl-missing-required-ace",
            ProtocolNames.Of(plan.RequireExactMatch(new SecuritySnapshot(
                WellKnownSids.BuiltinAdministrators,
                (ushort)(NtFlags.SE_DACL_PRESENT | NtFlags.SE_DACL_PROTECTED),
                true,
                missing)))));

        vectors.Add(new ConformanceVector(
            "sd/exact-match-refuses-unprotected-dacl",
            "dacl-inheritance-not-blocked",
            ProtocolNames.Of(plan.RequireExactMatch(new SecuritySnapshot(
                WellKnownSids.BuiltinAdministrators,
                NtFlags.SE_DACL_PRESENT,
                true,
                plan.ExpectedAces)))));

        List<AceSnapshot> inherited = new(plan.ExpectedAces)
        {
            new AceSnapshot(
                NtFlags.ACCESS_ALLOWED_ACE_TYPE,
                NtFlags.INHERITED_ACE,
                NtFlags.FILE_ALL_ACCESS,
                WellKnownSids.CreatorOwner),
        };
        vectors.Add(new ConformanceVector(
            "sd/exact-match-refuses-inherited-ace",
            "dacl-inheritance-not-blocked",
            ProtocolNames.Of(plan.RequireExactMatch(new SecuritySnapshot(
                WellKnownSids.BuiltinAdministrators,
                (ushort)(NtFlags.SE_DACL_PRESENT | NtFlags.SE_DACL_PROTECTED),
                true,
                inherited)))));

        // An ACE that matches in principal and mask but is INHERIT_ONLY grants
        // nothing on the object carrying it. Accepting it would accept a
        // directory whose SYSTEM and Administrators FullControl entries are
        // decorative, which is a directory nobody can administer and which
        // silently fails open on the next check that reads the ACL by shape.
        List<AceSnapshot> inheritOnly =
        [
            plan.ExpectedAces[0],
            plan.ExpectedAces[1],
            new AceSnapshot(
                NtFlags.ACCESS_ALLOWED_ACE_TYPE,
                (byte)(NtFlags.OBJECT_INHERIT_ACE | NtFlags.CONTAINER_INHERIT_ACE |
                    NtFlags.INHERIT_ONLY_ACE),
                plan.ExpectedAces[2].AccessMask,
                plan.ExpectedAces[2].Sid),
        ];
        vectors.Add(new ConformanceVector(
            "sd/exact-match-refuses-inherit-only-substitution",
            "dacl-unexpected-ace",
            ProtocolNames.Of(plan.RequireExactMatch(new SecuritySnapshot(
                WellKnownSids.BuiltinAdministrators,
                (ushort)(NtFlags.SE_DACL_PRESENT | NtFlags.SE_DACL_PROTECTED),
                true,
                inheritOnly)))));
    }

    private static SecuritySnapshot SnapshotOf(SecurityDescriptorPlan plan, string owner) =>
        new(
            owner,
            (ushort)(NtFlags.SE_DACL_PRESENT | NtFlags.SE_DACL_PROTECTED),
            true,
            plan.ExpectedAces);

    private static void AddAceEvaluationVectors(List<ConformanceVector> vectors)
    {
        const string sid = SimulatedFileSystem.ProofIdentitySid;

        // The rule the rejected PowerShell package got right only after two
        // corrections: an inherit-only ACE confers no access to the object it
        // sits on. C:\ carries an inherit-only Authenticated Users Modify ACE
        // including DELETE; treating it as effective would make the ancestor
        // check refuse on every stock Windows host.
        SecuritySnapshot inheritOnly = new(
            WellKnownSids.BuiltinAdministrators,
            NtFlags.SE_DACL_PRESENT,
            true,
            [
                new AceSnapshot(
                    NtFlags.ACCESS_ALLOWED_ACE_TYPE,
                    (byte)(NtFlags.OBJECT_INHERIT_ACE | NtFlags.CONTAINER_INHERIT_ACE |
                        NtFlags.INHERIT_ONLY_ACE),
                    NtFlags.FILE_ALL_ACCESS,
                    sid),
            ]);
        vectors.Add(new ConformanceVector(
            "ace/inherit-only-grants-nothing",
            "0x00000000",
            NtFlags.Hex(inheritOnly.EffectiveMaskFor(sid))));

        SecuritySnapshot effective = new(
            WellKnownSids.BuiltinAdministrators,
            NtFlags.SE_DACL_PRESENT,
            true,
            [
                new AceSnapshot(
                    NtFlags.ACCESS_ALLOWED_ACE_TYPE,
                    (byte)(NtFlags.OBJECT_INHERIT_ACE | NtFlags.CONTAINER_INHERIT_ACE),
                    NtFlags.FILE_ALL_ACCESS,
                    sid),
            ]);
        vectors.Add(new ConformanceVector(
            "ace/inheritable-but-not-inherit-only-grants",
            NtFlags.Hex(NtFlags.FILE_ALL_ACCESS),
            NtFlags.Hex(effective.EffectiveMaskFor(sid))));

        SecuritySnapshot denyFirst = new(
            WellKnownSids.BuiltinAdministrators,
            NtFlags.SE_DACL_PRESENT,
            true,
            [
                new AceSnapshot(NtFlags.ACCESS_DENIED_ACE_TYPE, 0, NtFlags.DELETE, sid),
                new AceSnapshot(NtFlags.ACCESS_ALLOWED_ACE_TYPE, 0, NtFlags.FILE_ALL_ACCESS, sid),
            ]);
        vectors.Add(new ConformanceVector(
            "ace/deny-before-allow-removes-the-bit",
            "false",
            (denyFirst.EffectiveMaskFor(sid) & NtFlags.DELETE) != 0 ? "true" : "false"));

        SecuritySnapshot other = new(
            WellKnownSids.BuiltinAdministrators,
            NtFlags.SE_DACL_PRESENT,
            true,
            [
                new AceSnapshot(
                    NtFlags.ACCESS_ALLOWED_ACE_TYPE, 0, NtFlags.FILE_ALL_ACCESS,
                    WellKnownSids.BuiltinUsers),
            ]);
        vectors.Add(new ConformanceVector(
            "ace/other-principal-grants-nothing-here",
            "0x00000000",
            NtFlags.Hex(other.EffectiveMaskFor(sid))));

        // FILE_DELETE_CHILD on a parent authorizes deleting a child regardless
        // of the child's own DACL. It is in the forbidden mask for that reason
        // and the mask must actually contain it.
        vectors.Add(new ConformanceVector(
            "ace/forbidden-mask-includes-delete-child",
            "true",
            (NtFlags.FORBIDDEN_FOR_PROOF_IDENTITY & NtFlags.FILE_DELETE_CHILD) != 0
                ? "true"
                : "false"));
        vectors.Add(new ConformanceVector(
            "ace/ancestor-mask-is-delete-and-control-only",
            NtFlags.Hex(NtFlags.DELETE | NtFlags.FILE_DELETE_CHILD | NtFlags.WRITE_DAC |
                NtFlags.WRITE_OWNER),
            NtFlags.Hex(InstallTransaction.AncestorForbiddenMask)));

        // The correction recorded in release evidence section 24: including
        // write-class rights in the ANCESTOR mask made the check refuse on
        // stock Windows, because C:\ProgramData grants BUILTIN\Users write by
        // default. A check nobody can satisfy is a check everybody disables.
        vectors.Add(new ConformanceVector(
            "ace/ancestor-mask-excludes-write-class",
            "0x00000000",
            NtFlags.Hex(InstallTransaction.AncestorForbiddenMask &
                (NtFlags.FILE_WRITE_DATA | NtFlags.FILE_APPEND_DATA | NtFlags.FILE_WRITE_EA |
                 NtFlags.FILE_WRITE_ATTRIBUTES))));
    }

    // ------------------------------------------------------------------ flags

    private static void AddFlagVectors(List<ConformanceVector> vectors)
    {
        SecurityDescriptorPlan plan = SecurityDescriptorPlan.ForDirectory(FixtureIdentity()).Value!;

        (string Name, HandleRelativeOpenRequest Request)[] requests =
        [
            ("volume-root", OpenRequests.VolumeRoot('C')),
            ("open-existing-directory", OpenRequests.OpenExistingDirectory("p", "AI-Dev-OS")),
            ("create-protected-directory",
                OpenRequests.CreateProtectedDirectory("p", "AI-Dev-OS", plan)),
            ("inspect-without-traversing", OpenRequests.InspectWithoutTraversing("AI-Dev-OS")),
            ("open-directory-for-deletion", OpenRequests.OpenDirectoryForDeletion("p", "AI-Dev-OS")),
            ("open-source-file", OpenRequests.OpenSourceFile("alpha.dll")),
            ("create-destination-file", OpenRequests.CreateDestinationFile("alpha.dll", plan)),
            ("open-installed-file-for-verification",
                OpenRequests.OpenInstalledFileForVerification("alpha.dll")),
            ("open-file-for-deletion", OpenRequests.OpenFileForDeletion("alpha.dll")),
        ];

        // The exact flag posture of every request this component can issue,
        // pinned as canonical JSON. A change to any bit of any request changes
        // the pinned string, so the diff shows up in review as a changed
        // expected value rather than as an invisible edit to a literal.
        foreach ((string name, HandleRelativeOpenRequest request) in requests)
        {
            vectors.Add(new ConformanceVector(
                string.Concat("flags/", name),
                ExpectedFlagString(name),
                CanonicalJson.SerializeToString(request.ToCanonical())));
        }

        // Structural properties, asserted over the whole request set rather
        // than one request at a time, so a newly added request cannot quietly
        // opt out.
        bool everyRelativeRefusesReparse = true;
        bool everyDirectoryDeniesDelete = true;
        bool everyCreateIsCreateOnly = true;
        bool everyCreateSuppliesDescriptor = true;
        foreach ((string name, HandleRelativeOpenRequest request) in requests)
        {
            bool isVolumeRoot = string.Equals(name, "volume-root", StringComparison.Ordinal);
            bool isInspection = string.Equals(name, "inspect-without-traversing", StringComparison.Ordinal);
            if (!isVolumeRoot && !isInspection && !request.RefusesReparse)
            {
                everyRelativeRefusesReparse = false;
            }

            if (!request.DeniesDeleteSharing)
            {
                everyDirectoryDeniesDelete = false;
            }

            if (request.CreateDisposition != NtFlags.FILE_OPEN &&
                request.CreateDisposition != NtFlags.FILE_CREATE)
            {
                everyCreateIsCreateOnly = false;
            }

            if (request.IsCreateOnly && request.SecurityDescriptor is null)
            {
                everyCreateSuppliesDescriptor = false;
            }
        }

        vectors.Add(new ConformanceVector(
            "flags/every-relative-request-sets-obj-dont-reparse",
            "true",
            everyRelativeRefusesReparse ? "true" : "false"));
        vectors.Add(new ConformanceVector(
            "flags/no-request-permits-delete-sharing",
            "true",
            everyDirectoryDeniesDelete ? "true" : "false"));
        vectors.Add(new ConformanceVector(
            "flags/only-open-or-create-dispositions-exist",
            "true",
            everyCreateIsCreateOnly ? "true" : "false"));
        vectors.Add(new ConformanceVector(
            "flags/every-create-supplies-a-descriptor-at-creation",
            "true",
            everyCreateSuppliesDescriptor ? "true" : "false"));

        // The inspection request is the one open that follows nothing: it uses
        // FILE_OPEN_REPARSE_POINT so a link can be examined rather than
        // traversed, and it deliberately does NOT set OBJ_DONT_REPARSE, because
        // an open whose whole purpose is to land on the link itself must not
        // fail when it does.
        vectors.Add(new ConformanceVector(
            "flags/inspection-opens-the-link-not-its-target",
            "true",
            OpenRequests.InspectWithoutTraversing("x").InspectsLinkWithoutTraversing &&
            !OpenRequests.InspectWithoutTraversing("x").RefusesReparse
                ? "true"
                : "false"));

        vectors.Add(new ConformanceVector(
            "flags/source-file-denies-write-and-delete-sharing",
            "0x00000001",
            NtFlags.Hex(OpenRequests.OpenSourceFile("alpha.dll").ShareAccess)));
    }

    /// <summary>
    /// The pinned canonical form of each request.
    ///
    /// These are literals rather than recomputations. A vector that rebuilt the
    /// request and compared it to itself would pass no matter what the flags
    /// were, which is the defect recorded as F2 in the release evidence.
    /// </summary>
    private static string ExpectedFlagString(string name) => name switch
    {
        "volume-root" =>
            "{\"createDisposition\":\"FILE_OPEN\",\"createOptions\":\"0x00000021\"," +
            "\"desiredAccess\":\"0x001200a1\",\"fileAttributes\":\"0x00000000\",\"name\":\"C:\\\\\"," +
            "\"objectAttributes\":\"0x00000a40\",\"purpose\":\"open-volume-root\"," +
            "\"securityDescriptor\":\"none\",\"shareAccess\":\"0x00000003\"}",
        "open-existing-directory" =>
            "{\"createDisposition\":\"FILE_OPEN\",\"createOptions\":\"0x00000021\"," +
            "\"desiredAccess\":\"0x001200a1\",\"fileAttributes\":\"0x00000000\",\"name\":\"AI-Dev-OS\"," +
            "\"objectAttributes\":\"0x00001240\",\"purpose\":\"p\"," +
            "\"securityDescriptor\":\"none\",\"shareAccess\":\"0x00000003\"}",
        "create-protected-directory" =>
            "{\"createDisposition\":\"FILE_CREATE\",\"createOptions\":\"0x00000021\"," +
            "\"desiredAccess\":\"0x001200a7\",\"fileAttributes\":\"0x00000010\",\"name\":\"AI-Dev-OS\"," +
            "\"objectAttributes\":\"0x00001240\",\"purpose\":\"p\",\"securityDescriptor\":" +
            "\"O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;" +
            SimulatedFileSystem.ProofIdentitySid + ")\",\"shareAccess\":\"0x00000003\"}",
        "inspect-without-traversing" =>
            "{\"createDisposition\":\"FILE_OPEN\",\"createOptions\":\"0x00200020\"," +
            "\"desiredAccess\":\"0x00120080\",\"fileAttributes\":\"0x00000000\",\"name\":\"AI-Dev-OS\"," +
            "\"objectAttributes\":\"0x00000240\",\"purpose\":\"inspect-link-without-traversing\"," +
            "\"securityDescriptor\":\"none\",\"shareAccess\":\"0x00000003\"}",
        "open-directory-for-deletion" =>
            "{\"createDisposition\":\"FILE_OPEN\",\"createOptions\":\"0x00000021\"," +
            "\"desiredAccess\":\"0x001300a1\",\"fileAttributes\":\"0x00000000\",\"name\":\"AI-Dev-OS\"," +
            "\"objectAttributes\":\"0x00001240\",\"purpose\":\"p\"," +
            "\"securityDescriptor\":\"none\",\"shareAccess\":\"0x00000003\"}",
        "open-source-file" =>
            "{\"createDisposition\":\"FILE_OPEN\",\"createOptions\":\"0x00000060\"," +
            "\"desiredAccess\":\"0x00120081\",\"fileAttributes\":\"0x00000000\",\"name\":\"alpha.dll\"," +
            "\"objectAttributes\":\"0x00001240\",\"purpose\":\"open-source-file\"," +
            "\"securityDescriptor\":\"none\",\"shareAccess\":\"0x00000001\"}",
        "create-destination-file" =>
            "{\"createDisposition\":\"FILE_CREATE\",\"createOptions\":\"0x00000062\"," +
            "\"desiredAccess\":\"0x00120183\",\"fileAttributes\":\"0x00000080\",\"name\":\"alpha.dll\"," +
            "\"objectAttributes\":\"0x00001240\",\"purpose\":\"create-destination-file\"," +
            "\"securityDescriptor\":" +
            "\"O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;" +
            SimulatedFileSystem.ProofIdentitySid + ")\",\"shareAccess\":\"0x00000000\"}",
        "open-installed-file-for-verification" =>
            "{\"createDisposition\":\"FILE_OPEN\",\"createOptions\":\"0x00000060\"," +
            "\"desiredAccess\":\"0x00120081\",\"fileAttributes\":\"0x00000000\",\"name\":\"alpha.dll\"," +
            "\"objectAttributes\":\"0x00001240\"," +
            "\"purpose\":\"open-installed-file-for-verification\"," +
            "\"securityDescriptor\":\"none\",\"shareAccess\":\"0x00000001\"}",
        "open-file-for-deletion" =>
            "{\"createDisposition\":\"FILE_OPEN\",\"createOptions\":\"0x00000060\"," +
            "\"desiredAccess\":\"0x00130081\",\"fileAttributes\":\"0x00000000\",\"name\":\"alpha.dll\"," +
            "\"objectAttributes\":\"0x00001240\",\"purpose\":\"open-installed-file-for-deletion\"," +
            "\"securityDescriptor\":\"none\",\"shareAccess\":\"0x00000001\"}",
        _ => "unpinned-request",
    };

    // --------------------------------------------------------- status mapping

    private static void AddStatusMappingVectors(List<ConformanceVector> vectors)
    {
        (uint Status, string Expected)[] cases =
        [
            (NtStatusCodes.STATUS_SUCCESS, "none"),
            (NtStatusCodes.STATUS_OBJECT_NAME_COLLISION, "native-already-exists"),
            (NtStatusCodes.STATUS_OBJECT_NAME_NOT_FOUND, "native-not-found"),
            (NtStatusCodes.STATUS_OBJECT_PATH_NOT_FOUND, "native-not-found"),
            (NtStatusCodes.STATUS_ACCESS_DENIED, "native-access-denied"),
            (NtStatusCodes.STATUS_PRIVILEGE_NOT_HELD, "native-access-denied"),
            (NtStatusCodes.STATUS_SHARING_VIOLATION, "native-sharing-violation"),
            (NtStatusCodes.STATUS_DELETE_PENDING, "native-changed-underneath"),
            (NtStatusCodes.STATUS_FILE_DELETED, "native-changed-underneath"),
            (NtStatusCodes.STATUS_REPARSE_POINT_ENCOUNTERED, "native-reparse-point-encountered"),
            (NtStatusCodes.STATUS_IO_REPARSE_TAG_NOT_HANDLED, "native-reparse-point-encountered"),
            (NtStatusCodes.STATUS_MOUNT_POINT_NOT_RESOLVED, "native-reparse-point-encountered"),
            (NtStatusCodes.STATUS_STOPPED_ON_SYMLINK, "native-reparse-point-encountered"),
            (NtStatusCodes.STATUS_NOT_A_DIRECTORY, "component-not-directory"),
            (NtStatusCodes.STATUS_FILE_IS_A_DIRECTORY, "component-not-directory"),
            (NtStatusCodes.STATUS_DIRECTORY_NOT_EMPTY, "removal-directory-not-empty"),
            (NtStatusCodes.STATUS_OBJECT_PATH_SYNTAX_BAD, "native-object-path-invalid"),
            (NtStatusCodes.STATUS_INVALID_HANDLE, "native-invalid-handle"),
            (NtStatusCodes.STATUS_OBJECT_TYPE_MISMATCH, "native-invalid-handle"),
            (NtStatusCodes.STATUS_NOT_SUPPORTED, "native-not-supported"),
            (NtStatusCodes.STATUS_INSUFFICIENT_RESOURCES, "native-resource-exhausted"),
            (0xC0000999u, "native-unexpected-failure"),
        ];

        foreach ((uint status, string expected) in cases)
        {
            vectors.Add(new ConformanceVector(
                string.Concat("ntstatus/", status.ToString("x8", CultureInfo.InvariantCulture)),
                expected,
                ProtocolNames.Of(NtStatusCodes.Classify(status))));
        }

        vectors.Add(new ConformanceVector(
            "ntstatus/success-predicate",
            "true:false:false",
            string.Concat(
                NtStatusCodes.Succeeded(NtStatusCodes.STATUS_SUCCESS) ? "true" : "false",
                ":",
                NtStatusCodes.Succeeded(NtStatusCodes.STATUS_ACCESS_DENIED) ? "true" : "false",
                ":",
                NtStatusCodes.Succeeded(NtStatusCodes.STATUS_STOPPED_ON_SYMLINK) ? "true" : "false")));
    }

    // ---------------------------------------------------------- configuration

    private static void AddConfigurationVectors(List<ConformanceVector> vectors)
    {
        // Empty by decision, exactly as the production pinned bundle
        // fingerprint table is empty and for the same reason.
        vectors.Add(new ConformanceVector(
            "config/installable-candidate-table-is-empty",
            "0",
            ProofConfiguration.Installable.Count.ToString(CultureInfo.InvariantCulture)));

        // The self-test fixture is a fixture. If it ever appears in the
        // installable table, a test seam has become a trust root, which is the
        // pattern the release evidence records as N-04.
        bool fixtureInstallable = false;
        foreach (ProofCandidate candidate in ProofConfiguration.Installable)
        {
            if (string.Equals(
                    candidate.CandidateId,
                    ProofConfiguration.SelfTestFixtureCandidate.CandidateId,
                    StringComparison.Ordinal))
            {
                fixtureInstallable = true;
            }
        }

        vectors.Add(new ConformanceVector(
            "config/self-test-fixture-is-not-installable",
            "false",
            fixtureInstallable ? "true" : "false"));

        vectors.Add(new ConformanceVector(
            "config/lookup-by-identifier-refuses-unknown",
            "candidate-unknown",
            ProtocolNames.Of(ProofConfiguration.FindInstallable("supervisor-1-0-0").Refusal)));
        vectors.Add(new ConformanceVector(
            "config/lookup-refuses-a-digest-shaped-identifier",
            "argument-invalid",
            ProtocolNames.Of(ProofConfiguration.FindInstallable(new string('a', 64)).Refusal)));
        vectors.Add(new ConformanceVector(
            "config/lookup-refuses-the-fixture-identifier",
            "candidate-unknown",
            ProtocolNames.Of(ProofConfiguration.FindInstallable(
                ProofConfiguration.SelfTestFixtureCandidate.CandidateId).Refusal)));

        vectors.Add(new ConformanceVector(
            "config/install-root-components",
            "AI-Dev-OS/Stage17-Proof",
            string.Concat(
                ProofConfiguration.InstallRootFirstComponent,
                "/",
                ProofConfiguration.InstallRootSecondComponent)));

        // The fingerprint the fixture bytes must recompute to, pinned as a
        // literal. A literal-versus-computed comparison is the only kind that
        // can fail.
        vectors.Add(new ConformanceVector(
            "config/fixture-envelope-fingerprint",
            ProofConfiguration.SelfTestFixtureCandidate.ManifestFingerprint,
            FixtureEnvelopeFingerprint()));
    }

    private static string FixtureEnvelopeFingerprint()
    {
        List<CanonicalObject> measurements = [];
        foreach (string name in ProofConfiguration.SelfTestFixtureCandidate.FileNames)
        {
            byte[] bytes = FixtureContent(name);
            measurements.Add(new CanonicalObject()
                .Set("name", name)
                .Set("sha256", ProofConfiguration.Sha256Hex(bytes))
                .Set("size", bytes.LongLength));
        }

        return InstallTransaction.SourceEnvelopeFingerprint(
            ProofConfiguration.SelfTestFixtureCandidate,
            measurements);
    }

    private static byte[] FixtureContent(string name) =>
        Utf8.GetBytes(string.Concat("ai-dev-os-stage17-proof-fixture:", name));

    // ------------------------------------------------------------------- plan

    private static void AddPlanVectors(List<ConformanceVector> vectors)
    {
        Outcome<InstallPlan> plan = InstallPlan.Derive(
            Token,
            ProofConfiguration.SelfTestFixtureCandidate);
        vectors.Add(new ConformanceVector(
            "plan/derives-exact-components",
            "{\"candidateId\":\"self-test-fixture-not-installable\"," +
            "\"destinationComponents\":[\"AI-Dev-OS\",\"Stage17-Proof\"," +
            "\"0123456789abcdef0123456789abcdef\"]," +
            "\"fileNames\":[\"alpha.dll\",\"beta.exe\"]," +
            "\"installRecordFileName\":\"stage17-proof-install-record.json\"," +
            "\"manifestFileName\":\"stage17-proof-manifest.json\"," +
            "\"runToken\":\"0123456789abcdef0123456789abcdef\"}",
            plan.Ok && plan.Value is not null
                ? CanonicalJson.SerializeToString(plan.Value.ToCanonical())
                : ProtocolNames.Of(plan.Refusal)));

        vectors.Add(new ConformanceVector(
            "plan/refuses-malformed-token",
            "token-malformed",
            ProtocolNames.Of(InstallPlan.Derive(
                "not-a-token",
                ProofConfiguration.SelfTestFixtureCandidate).Refusal)));

        vectors.Add(new ConformanceVector(
            "plan/refuses-candidate-naming-the-manifest",
            "source-file-name-invalid",
            ProtocolNames.Of(InstallPlan.Derive(Token, new ProofCandidate(
                "x-fixture",
                "windows-supervisor",
                "1.0.0",
                "sealed",
                new string('0', 64),
                ["alpha.dll", ProofConfiguration.InstalledManifestFileName])).Refusal)));

        vectors.Add(new ConformanceVector(
            "plan/refuses-case-duplicate-file-names",
            "source-file-duplicate-case-insensitive",
            ProtocolNames.Of(InstallPlan.Derive(Token, new ProofCandidate(
                "x-fixture",
                "windows-supervisor",
                "1.0.0",
                "sealed",
                new string('0', 64),
                ["alpha.dll", "ALPHA.DLL"])).Refusal)));

        vectors.Add(new ConformanceVector(
            "plan/refuses-path-shaped-file-name",
            "source-file-name-invalid",
            ProtocolNames.Of(InstallPlan.Derive(Token, new ProofCandidate(
                "x-fixture",
                "windows-supervisor",
                "1.0.0",
                "sealed",
                new string('0', 64),
                ["..\\..\\windows\\system32\\evil.dll"])).Refusal)));
    }

    // ------------------------------------------------------------------- gate

    private static void AddGateVectors(List<ConformanceVector> vectors)
    {
#if AIDEVOS_STAGE17_REVIEWED_PROOF_MODE
        const string expectedFlavor = "reviewed-proof-mode";
        const string expectedProofMode = "true";
#else
        const string expectedFlavor = "sealed";
        const string expectedProofMode = "false";
#endif
        vectors.Add(new ConformanceVector("gate/build-flavor", expectedFlavor, MutationGate.BuildFlavor));
        vectors.Add(new ConformanceVector(
            "gate/proof-mode-compiled-in",
            expectedProofMode,
            MutationGate.ProofModeCompiledIn ? "true" : "false"));
        vectors.Add(new ConformanceVector(
            "gate/mutating-permitted-couples-to-recipe",
            "coupled",
            MutationGate.MutatingOperationsPermitted == MutationGate.ProofModeCompiledIn
                ? "coupled"
                : "decoupled"));
        vectors.Add(new ConformanceVector(
            "gate/unauthorized-caller-is-refused",
            "mutating-operations-unauthorized",
            ProtocolNames.Of(MutationGate.Authorize(null))));

        // The gate is on the operation path, not beside it. Both mutating entry
        // points take the capability by signature and route through Authorize,
        // so a null caller is refused in BOTH recipes with factor 2's own code.
        vectors.Add(new ConformanceVector(
            "gate/install-refuses-unauthorized-caller",
            "mutating-operations-unauthorized:authorize",
            StepAndCode(InstallTransaction.Install(
                new SimulatedFileSystem(null),
                Token,
                ProofConfiguration.SelfTestFixtureCandidate,
                "C:\\staging\\closure",
                authorization: null))));
        vectors.Add(new ConformanceVector(
            "gate/remove-refuses-unauthorized-caller",
            "mutating-operations-unauthorized:authorize",
            StepAndCode(InstallTransaction.Remove(
                new SimulatedFileSystem(null),
                Token,
                authorization: null))));
    }

    private static string StepAndCode(TransactionReport report) =>
        string.Concat(ProtocolNames.Of(report.Refusal), ":", report.FailedStep);

    /// <summary>
    /// What the native adapter has actually done in this process, read from its
    /// own counters. Naming the type here does not construct it; the counters are
    /// what prove that.
    /// </summary>
    internal static string NativeFileSystemActivity() => string.Create(
        CultureInfo.InvariantCulture,
        $"instantiations={NativeHandleRelativeFileSystem.InstantiationCount} " +
        $"nativeOpens={NativeHandleRelativeFileSystem.NativeOpenAttemptCount}");

    // -------------------------------------------------- contract-level linkage

    /// <summary>
    /// A second implementation of the handle-relative contract that opens
    /// nothing, so the ancestor chain it produces can only have come from the
    /// shared base class.
    ///
    /// It exists because of an audit finding whose lesson was structural. The
    /// contract's flagship property — every ancestor handle retained, observable
    /// through <c>Parent</c> and <c>Depth</c> — was asserted only against the
    /// simulation, which wired the parent correctly. The native adapter did not
    /// wire it at all, so in the binary that would actually run the property was
    /// vacuous while all four retention vectors passed. A vector that can only
    /// see one implementation cannot see an implementation that does not
    /// implement the contract.
    ///
    /// This probe closes that: it declines to answer every question except "did
    /// the open work", which is now the only question an implementation is asked.
    /// If construction of <see cref="OpenedObject"/> were ever moved back out of
    /// the base class, this type would stop compiling rather than start lying.
    /// </summary>
    private sealed class LinkageProbeFileSystem : HandleRelativeFileSystem
    {
        private readonly List<CanonicalObject> log = [];

        public override IReadOnlyList<CanonicalObject> OperationLog => log;

        protected override RefusalCode OpenVolumeRootCore(
            char driveLetter,
            HandleRelativeOpenRequest request,
            long ordinal) => RefusalCode.None;

        protected override RefusalCode OpenRelativeCore(
            OpenedObject parent,
            HandleRelativeOpenRequest request,
            long ordinal) => RefusalCode.None;

        public override RefusalCode RewindToStart(OpenedObject handle) => RefusalCode.None;

        public override void CloseHandle(OpenedObject handle)
        {
            // Nothing to release: this implementation never opened anything.
        }

        public override Outcome<KnownFolderResolution> ResolveCommonApplicationData() =>
            Outcome<KnownFolderResolution>.Refused(RefusalCode.KnownFolderUnresolvable);

        public override Outcome<ObjectFacts> QueryFacts(OpenedObject handle) =>
            Outcome<ObjectFacts>.Refused(RefusalCode.NativeNotSupported);

        public override Outcome<SecuritySnapshot> QuerySecurity(OpenedObject handle) =>
            Outcome<SecuritySnapshot>.Refused(RefusalCode.NativeNotSupported);

        public override Outcome<AccessCheckResult> AccessCheckAsProofIdentity(OpenedObject handle) =>
            Outcome<AccessCheckResult>.Refused(RefusalCode.NativeNotSupported);

        public override Outcome<DirectoryListing> ListDirectory(OpenedObject handle) =>
            Outcome<DirectoryListing>.Refused(RefusalCode.NativeNotSupported);

        public override Outcome<FileMeasurement> MeasureFile(OpenedObject handle) =>
            Outcome<FileMeasurement>.Refused(RefusalCode.NativeNotSupported);

        public override Outcome<FileMeasurement> WriteThroughHandle(OpenedObject handle, byte[] content) =>
            Outcome<FileMeasurement>.Refused(RefusalCode.NativeNotSupported);

        public override Outcome<byte[]> ReadThroughHandle(OpenedObject handle, int maximumBytes) =>
            Outcome<byte[]>.Refused(RefusalCode.NativeNotSupported);

        public override RefusalCode FlushBuffers(OpenedObject handle) => RefusalCode.NativeNotSupported;

        public override RefusalCode DeleteThroughHandle(OpenedObject handle) =>
            RefusalCode.NativeNotSupported;

        public override Outcome<ProofIdentity> ResolveProofIdentity() =>
            Outcome<ProofIdentity>.Refused(RefusalCode.ProofIdentityUnacceptable);
    }

    /// <summary>
    /// The ancestor chain, asserted against an implementation that supplies no
    /// part of it, and against the simulation, so the property is shown to come
    /// from the contract rather than from one cooperative implementation.
    /// </summary>
    private static void AddContractLinkageVectors(List<ConformanceVector> vectors)
    {
        // The SAME expected string for both implementations, walked over the two
        // components the simulation already has, so the two are genuinely
        // comparable rather than each being graded against its own answer.
        const string expectedChain =
            "depth=0,1,2 names=C:\\,staging,closure retained=true denies-delete=true";

        vectors.Add(new ConformanceVector(
            "linkage/probe/chain-is-built-by-the-contract",
            expectedChain,
            LinkageOf(new LinkageProbeFileSystem())));

        vectors.Add(new ConformanceVector(
            "linkage/simulation/chain-is-built-by-the-contract",
            expectedChain,
            LinkageOf(new SimulatedFileSystem(new HostileConditions()))));

        // The same walk, with the middle handle released. Both implementations
        // must report the chain broken, because neither of them is what tracks
        // it.
        vectors.Add(new ConformanceVector(
            "linkage/probe/chain-breaks-when-an-ancestor-is-released",
            "retained=false",
            ChainAfterReleasingMiddle(new LinkageProbeFileSystem())));
        vectors.Add(new ConformanceVector(
            "linkage/simulation/chain-breaks-when-an-ancestor-is-released",
            "retained=false",
            ChainAfterReleasingMiddle(new SimulatedFileSystem(new HostileConditions()))));

        // A handle-relative open whose name is a path is refused in the shared
        // half, so neither implementation can be the one that forgets. Driven
        // through the probe, which performs no validation of its own at all.
        LinkageProbeFileSystem grammar = new();
        Outcome<OpenedObject> grammarRoot = grammar.OpenVolumeRoot('C', OpenRequests.VolumeRoot('C'));
        Outcome<OpenedObject> pathShaped = grammar.OpenRelative(
            grammarRoot.Value!,
            OpenRequests.OpenExistingDirectory("p", "ProgramData\\AI-Dev-OS"));
        grammarRoot.Value!.Dispose();
        vectors.Add(new ConformanceVector(
            "linkage/probe/path-shaped-name-is-refused-by-the-contract",
            "path-used-without-handle",
            ProtocolNames.Of(pathShaped.Refusal)));

        // An implementation is never consulted about an already-closed parent
        // either: the shared half refuses first, with the retention code.
        LinkageProbeFileSystem closed = new();
        Outcome<OpenedObject> closedRoot = closed.OpenVolumeRoot('C', OpenRequests.VolumeRoot('C'));
        closedRoot.Value!.Dispose();
        Outcome<OpenedObject> afterClose = closed.OpenRelative(
            closedRoot.Value!,
            OpenRequests.OpenExistingDirectory("p", "ProgramData"));
        vectors.Add(new ConformanceVector(
            "linkage/probe/closed-parent-is-refused-by-the-contract",
            "ancestor-handle-not-retained",
            ProtocolNames.Of(afterClose.Refusal)));
    }

    private static string LinkageOf(IHandleRelativeFileSystem fs)
    {
        Outcome<OpenedObject> root = fs.OpenVolumeRoot('C', OpenRequests.VolumeRoot('C'));
        if (!root.Ok || root.Value is null)
        {
            return string.Concat("volume-root-refused:", ProtocolNames.Of(root.Refusal));
        }

        Outcome<OpenedObject> first = fs.OpenRelative(
            root.Value,
            OpenRequests.OpenExistingDirectory("p", "staging"));
        if (!first.Ok || first.Value is null)
        {
            return string.Concat("first-hop-refused:", ProtocolNames.Of(first.Refusal));
        }

        Outcome<OpenedObject> second = fs.OpenRelative(
            first.Value,
            OpenRequests.OpenExistingDirectory("p", "closure"));
        if (!second.Ok || second.Value is null)
        {
            return string.Concat("second-hop-refused:", ProtocolNames.Of(second.Refusal));
        }

        string described = string.Create(
            CultureInfo.InvariantCulture,
            $"depth={root.Value.Depth},{first.Value.Depth},{second.Value.Depth} " +
            $"names={NameChainOf(second.Value)} " +
            $"retained={(second.Value.ChainIsRetained ? "true" : "false")} " +
            $"denies-delete={(second.Value.ChainDeniesDeleteSharing ? "true" : "false")}");

        second.Value.Dispose();
        first.Value.Dispose();
        root.Value.Dispose();
        return described;
    }

    /// <summary>Root-to-leaf component names, which only a real parent link can produce.</summary>
    private static string NameChainOf(OpenedObject leaf)
    {
        List<string> names = [];
        for (OpenedObject? current = leaf; current is not null; current = current.Parent)
        {
            names.Add(current.ComponentName);
        }

        names.Reverse();
        return string.Join(',', names);
    }

    private static string ChainAfterReleasingMiddle(IHandleRelativeFileSystem fs)
    {
        Outcome<OpenedObject> root = fs.OpenVolumeRoot('C', OpenRequests.VolumeRoot('C'));
        Outcome<OpenedObject> first = fs.OpenRelative(
            root.Value!,
            OpenRequests.OpenExistingDirectory("p", "staging"));
        Outcome<OpenedObject> second = fs.OpenRelative(
            first.Value!,
            OpenRequests.OpenExistingDirectory("p", "closure"));
        if (!second.Ok || second.Value is null || first.Value is null)
        {
            return "setup-failed";
        }

        first.Value.Dispose();
        string described = second.Value.ChainIsRetained ? "retained=true" : "retained=false";
        second.Value.Dispose();
        root.Value!.Dispose();
        return described;
    }

    // ------------------------------------------------------- handle retention

    private static void AddHandleRetentionVectors(List<ConformanceVector> vectors)
    {
        // A retained handle opened WITHOUT delete sharing is what stops an
        // ancestor being renamed underneath the transaction. The pair below is
        // the whole argument in two lines: the rename fails while the handle is
        // held and succeeds the moment it is released. If the share mode were
        // widened to include FILE_SHARE_DELETE, the first half would start
        // returning "renamed" and the vector would fail by name.
        SimulatedFileSystem fs = new(null);
        Outcome<OpenedObject> root = fs.OpenVolumeRoot('C', OpenRequests.VolumeRoot('C'));
        Outcome<OpenedObject> programData = fs.OpenRelative(
            root.Value!,
            OpenRequests.OpenExistingDirectory("p", "ProgramData"));

        bool renamedWhileHeld = fs.TryHostileRename("ProgramData", "ProgramData-attacker");
        programData.Value!.Dispose();
        bool renamedAfterRelease = fs.TryHostileRename("ProgramData", "ProgramData-attacker");
        root.Value!.Dispose();

        vectors.Add(new ConformanceVector(
            "retention/rename-blocked-while-handle-held",
            "blocked",
            renamedWhileHeld ? "renamed" : "blocked"));
        vectors.Add(new ConformanceVector(
            "retention/rename-succeeds-once-handle-released",
            "renamed",
            renamedAfterRelease ? "renamed" : "blocked"));

        // Early disposal of an ancestor is detected before anything is created.
        // This is the installer's analogue of the VerifiedClosureLease property:
        // holding a handle for part of a transaction is not holding it for the
        // transaction.
        SimulatedFileSystem second = new(null);
        Outcome<OpenedObject> secondRoot = second.OpenVolumeRoot('C', OpenRequests.VolumeRoot('C'));
        Outcome<OpenedObject> child = second.OpenRelative(
            secondRoot.Value!,
            OpenRequests.OpenExistingDirectory("p", "ProgramData"));
        RefusalCode intactBefore = InstallTransaction.RequireIntactDirectory(second, child.Value!);
        secondRoot.Value!.Dispose();
        RefusalCode intactAfter = InstallTransaction.RequireIntactDirectory(second, child.Value!);
        child.Value!.Dispose();

        vectors.Add(new ConformanceVector(
            "retention/chain-intact-before-early-disposal",
            "none",
            ProtocolNames.Of(intactBefore)));
        vectors.Add(new ConformanceVector(
            "retention/chain-refused-after-early-disposal",
            "ancestor-handle-not-retained",
            ProtocolNames.Of(intactAfter)));

        // A share mode that permitted delete would be caught even if every
        // other check passed, because the chain property is evaluated from the
        // requests the handles were opened with rather than from a comment.
        SimulatedFileSystem third = new(null);
        HandleRelativeOpenRequest permissive = new(
            "test-only-permissive-share",
            "C:\\",
            NtFlags.FILE_LIST_DIRECTORY | NtFlags.SYNCHRONIZE,
            0,
            NtFlags.FILE_SHARE_READ | NtFlags.FILE_SHARE_WRITE | NtFlags.FILE_SHARE_DELETE,
            NtFlags.FILE_OPEN,
            NtFlags.FILE_DIRECTORY_FILE,
            OpenRequests.VolumeRootObjectAttributes,
            securityDescriptor: null);
        Outcome<OpenedObject> permissiveRoot = third.OpenVolumeRoot('C', permissive);
        RefusalCode permissiveCheck = InstallTransaction.RequireIntactDirectory(
            third,
            permissiveRoot.Value!);
        permissiveRoot.Value!.Dispose();
        vectors.Add(new ConformanceVector(
            "retention/delete-sharing-is-refused",
            "ancestor-sharing-permits-delete",
            ProtocolNames.Of(permissiveCheck)));
    }

    // ------------------------------------------------ native information classes

    /// <summary>
    /// The numeric information-class ordinals the adapter passes to
    /// <c>GetFileInformationByHandleEx</c>, pinned as literals.
    ///
    /// They are pinned because getting them wrong is invisible to every other
    /// kind of test. The adapter used <c>3</c> and <c>2</c> — values from
    /// <c>FILE_INFORMATION_CLASS</c>, the enum <c>NtQueryDirectoryFile</c> takes.
    /// In <c>FILE_INFO_BY_HANDLE_CLASS</c>, which is what this function takes,
    /// <c>2</c> is <c>FileNameInfo</c> and <c>3</c> is <c>FileRenameInfo</c>, a
    /// SET-only class. The structure offsets the adapter parsed were correct for
    /// <c>FILE_FULL_DIR_INFO</c> throughout, which is what isolated the defect to
    /// the two ordinals rather than to the parsing.
    ///
    /// A literal-versus-literal comparison would be worthless here, so these
    /// compare a hand-written expected value from the Windows SDK header against
    /// the constant the adapter actually passes.
    /// </summary>
    private static void AddInformationClassVectors(List<ConformanceVector> vectors)
    {
        (string Name, int Expected, int Actual)[] classes =
        [
            ("FileStandardInfo", 1, NativeHandleRelativeFileSystem.FileStandardInfoClass),
            ("FileIdInfo", 18, NativeHandleRelativeFileSystem.FileIdInfoClass),
            ("FileFullDirectoryInfo", 14, NativeHandleRelativeFileSystem.FileFullDirectoryInfoClass),
            ("FileFullDirectoryRestartInfo", 15, NativeHandleRelativeFileSystem.FileFullDirectoryRestartInfoClass),
        ];

        foreach ((string name, int expected, int actual) in classes)
        {
            vectors.Add(new ConformanceVector(
                string.Concat("native-info-class/", name),
                expected.ToString(CultureInfo.InvariantCulture),
                actual.ToString(CultureInfo.InvariantCulture)));
        }

        // The two directory classes belong to the same family and must be
        // adjacent restart/continue partners. Two ordinals from different enums
        // could each be individually plausible; this is the relationship between
        // them.
        vectors.Add(new ConformanceVector(
            "native-info-class/restart-is-the-continue-partner",
            "true",
            NativeHandleRelativeFileSystem.FileFullDirectoryRestartInfoClass ==
                NativeHandleRelativeFileSystem.FileFullDirectoryInfoClass + 1
                ? "true"
                : "false"));

        vectors.Add(new ConformanceVector(
            "native-info-class/end-of-enumeration-is-error-18",
            "18",
            NativeHandleRelativeFileSystem.NoMoreFilesError.ToString(CultureInfo.InvariantCulture)));
    }

    // ------------------------------------------------------------ transaction

    private static void AddTransactionVectors(List<ConformanceVector> vectors)
    {
#if AIDEVOS_STAGE17_REVIEWED_PROOF_MODE
        AddReviewedProofTransactionVectors(vectors);
#else
        // A sealed build cannot construct the capability, so it cannot run the
        // transaction even against the simulated filesystem. That is the
        // correct outcome and it is asserted rather than worked around: the
        // vectors that exercise the transaction exist only in the reviewed
        // proof recipe, which is why the two recipes report different vector
        // counts and different digests.
        vectors.Add(new ConformanceVector(
            "transaction/sealed-build-cannot-run-the-transaction",
            "mutating-operations-unauthorized",
            ProtocolNames.Of(InstallTransaction.Install(
                new SimulatedFileSystem(null),
                Token,
                ProofConfiguration.SelfTestFixtureCandidate,
                "C:\\staging\\closure",
                authorization: null).Refusal)));
#endif
    }

#if AIDEVOS_STAGE17_REVIEWED_PROOF_MODE
    private static string RunInstall(HostileConditions? conditions, out SimulatedFileSystem fs)
    {
        fs = new SimulatedFileSystem(conditions);
        fs.PopulateSource(ProofConfiguration.SelfTestFixtureCandidate.FileNames, FixtureContent);
        TransactionReport report = InstallTransaction.Install(
            fs,
            Token,
            ProofConfiguration.SelfTestFixtureCandidate,
            SimulatedFileSystem.SourcePath,
            ReviewedProofModeAuthorization.IssueForReviewedBoundedProof());
        return StepAndCode(report);
    }

    private static void AddReviewedProofTransactionVectors(List<ConformanceVector> vectors)
    {
        vectors.Add(new ConformanceVector(
            "transaction/install-happy-path",
            "none:",
            RunInstall(null, out SimulatedFileSystem happy)));
        vectors.Add(new ConformanceVector(
            "transaction/install-leaf-exists-after-happy-path",
            "true",
            happy.Find("ProgramData", "AI-Dev-OS", "Stage17-Proof", Token) is not null
                ? "true"
                : "false"));
        vectors.Add(new ConformanceVector(
            "transaction/install-closes-every-handle",
            "0",
            happy.OpenHandleCount.ToString(CultureInfo.InvariantCulture)));

        // The exact operation sequence, pinned. A step that is skipped,
        // reordered, or added changes the string and the vector fails by name.
        vectors.Add(new ConformanceVector(
            "transaction/install-operation-sequence",
            ExpectedInstallSequence,
            happy.OperationSequence()));

        (string Name, HostileConditions Conditions, string Expected)[] hostile =
        [
            ("junction-at-first-component",
                new HostileConditions { JunctionAt = ProofConfiguration.InstallRootFirstComponent },
                "native-reparse-point-encountered:open-existing-ancestor"),
            ("user-owned-first-component",
                new HostileConditions { UserOwnedDirectoryAt = ProofConfiguration.InstallRootFirstComponent },
                "owner-untrusted:inspect-existing-ancestor"),
            ("extra-ace-on-first-component",
                new HostileConditions { ExtraAceAt = ProofConfiguration.InstallRootFirstComponent },
                "dacl-unexpected-ace:inspect-existing-ancestor"),
            ("inherit-only-read-ace-on-first-component",
                new HostileConditions { InheritOnlyReadAceAt = ProofConfiguration.InstallRootFirstComponent },
                "dacl-unexpected-ace:inspect-existing-ancestor"),
            ("inherited-ace-on-first-component",
                new HostileConditions { InheritedAceAt = ProofConfiguration.InstallRootFirstComponent },
                "dacl-inheritance-not-blocked:inspect-existing-ancestor"),
            ("collision-during-create-only-on-leaf",
                new HostileConditions { CollideOnCreateAt = Token },
                "installed-version-exists:create-protected-directory"),
            // The DACL of a directory this transaction created must be exactly
            // the one it asked for. An extra grant is caught by the read-back
            // comparison before the AccessCheck ever runs, which is the earlier
            // and stricter of the two guards.
            ("extra-grant-on-created-ancestor",
                new HostileConditions
                {
                    ExtraGrantAt = ProofConfiguration.InstallRootFirstComponent,
                    ExtraGrantMask = NtFlags.FILE_DELETE_CHILD,
                },
                "dacl-unexpected-ace:verify-created-directory"),
            ("extra-grant-on-created-leaf",
                new HostileConditions
                {
                    ExtraGrantAt = Token,
                    ExtraGrantMask = NtFlags.FILE_WRITE_DATA,
                },
                "dacl-unexpected-ace:verify-created-directory"),

            // Finding F5, reproduced. The created directories have a perfect
            // DACL and it does not help: delete-child on the SHARED ancestor
            // authorizes deleting them regardless. Only the kernel's own
            // AccessCheck against the standard token catches this, because the
            // read-back DACL comparison never looks at C:\ProgramData — that
            // directory is not ours to compare against a plan.
            ("delete-child-on-the-shared-known-folder",
                new HostileConditions { DeleteChildOnKnownFolder = true },
                "proof-identity-holds-delete-child:verify-protection"),
            ("dacl-change-on-the-shared-known-folder",
                new HostileConditions { DaclChangeOnKnownFolder = true },
                "proof-identity-holds-dacl-change:verify-protection"),
            ("access-check-against-a-non-standard-token",
                new HostileConditions { TokenKind = "elevated" },
                "standard-token-unavailable:verify-protection"),
            ("non-ntfs-volume",
                new HostileConditions { FileSystemName = "FAT32" },
                "volume-filesystem-unsupported:open-known-folder"),
            ("well-known-proof-identity",
                new HostileConditions { ProofIdentityIsWellKnown = true },
                "proof-identity-unacceptable:resolve-proof-identity"),
            ("extra-file-in-the-source-root",
                new HostileConditions { ExtraSourceFile = "extra.dll" },
                "source-file-unexpected:measure-source-closure"),
            ("case-duplicate-in-the-source-root",
                new HostileConditions { CaseDuplicateSourceFile = "ALPHA.DLL" },
                "source-file-duplicate-case-insensitive:measure-source-closure"),
            ("source-bytes-swapped-after-measurement",
                new HostileConditions { SwapSourceFileAfterMeasure = "alpha.dll" },
                "source-manifest-fingerprint-unknown:measure-source-closure"),
            ("measurement-not-through-the-handle",
                new HostileConditions { MeasurementNotThroughHandle = true },
                "source-measurement-not-through-handle:measure-source-closure"),

            // The offset defect, injected as the adapter exhibited it: the
            // rewind reports success and moves nothing, so the measurement that
            // follows the read starts at end of file and hashes zero bytes. The
            // size cross-check is what catches it, and it is the reason that
            // cross-check exists instead of a hardcoded `true`.
            //
            // This vector is two-sided: it fails if the cross-check is removed,
            // and transaction/install-happy-path fails if either rewind call is
            // removed, so neither the guard nor its caller can be deleted
            // silently.
            ("rewind-that-moves-nothing",
                new HostileConditions { SkipRewind = true },
                "source-measurement-not-through-handle:measure-source-closure"),

            // A failed directory enumeration reported as an empty directory.
            // This is the strongest of the enumeration vectors because an empty
            // source listing does NOT stop the install: every planned file is
            // then opened by name and found, so the transaction would succeed
            // while its extra-file and case-duplicate scans had seen nothing at
            // all. Expecting a refusal here is expecting the enumeration failure
            // to be propagated rather than swallowed.
            ("enumeration-failure-in-the-source-root",
                new HostileConditions { EnumerationFailsAt = "closure" },
                "native-unexpected-failure:measure-source-closure"),

            // The same failure at the destination leaf, after the copy, where it
            // would otherwise defeat the extra-entry scan.
            ("enumeration-failure-in-the-destination-leaf",
                new HostileConditions { EnumerationFailsAt = Token },
                "native-unexpected-failure:re-measure-installed-closure"),

            // A component replaced between one check and the next. Retaining
            // the handle without delete sharing is what should make this
            // unreachable on a real filesystem, which is why the simulation
            // has to reach in and do it directly; the re-verification before
            // create is what notices if it ever becomes reachable.
            ("component-swapped-between-checks",
                new HostileConditions
                {
                    SwapIdentityAfterOpenAt = ProofConfiguration.InstallRootFirstComponent,
                },
                "component-identity-mismatch:assert-chain-retained-before-create"),

            // An extra file dropped into the destination leaf after the copy
            // and before the final re-measurement. It is refused, not deleted:
            // an object this transaction cannot explain is an operator
            // decision, and a cleanup routine that deletes what it cannot
            // explain is an arbitrary-delete primitive.
            ("extra-file-planted-in-the-destination-leaf",
                new HostileConditions { ExtraDestinationFileAfterCopy = "planted.dll" },
                "destination-extra-entry:re-measure-installed-closure"),
        ];

        foreach ((string name, HostileConditions conditions, string expected) in hostile)
        {
            vectors.Add(new ConformanceVector(
                string.Concat("transaction/hostile/", name),
                expected,
                RunInstall(conditions, out SimulatedFileSystem _)));
        }

        // A junction planted at EACH ancestor position, not just the first.
        foreach (string position in new[]
        {
            ProofConfiguration.InstallRootFirstComponent,
            ProofConfiguration.InstallRootSecondComponent,
        })
        {
            vectors.Add(new ConformanceVector(
                string.Concat("transaction/hostile/junction-at/", position),
                "native-reparse-point-encountered:open-existing-ancestor",
                RunInstall(new HostileConditions { JunctionAt = position }, out SimulatedFileSystem _)));
        }

        // A second install of the same token must be refused, never overwritten.
        SimulatedFileSystem twice = new(null);
        twice.PopulateSource(ProofConfiguration.SelfTestFixtureCandidate.FileNames, FixtureContent);
        _ = InstallTransaction.Install(
            twice,
            Token,
            ProofConfiguration.SelfTestFixtureCandidate,
            SimulatedFileSystem.SourcePath,
            ReviewedProofModeAuthorization.IssueForReviewedBoundedProof());
        TransactionReport second = InstallTransaction.Install(
            twice,
            Token,
            ProofConfiguration.SelfTestFixtureCandidate,
            SimulatedFileSystem.SourcePath,
            ReviewedProofModeAuthorization.IssueForReviewedBoundedProof());
        vectors.Add(new ConformanceVector(
            "transaction/existing-installed-version-is-refused-not-overwritten",
            "installed-version-exists:create-protected-directory",
            StepAndCode(second)));

        AddRemovalVectors(vectors);
    }

    private static void AddRemovalVectors(List<ConformanceVector> vectors)
    {
        SimulatedFileSystem fs = Installed();

        // Every removal vector below depends on a fixture install having
        // completed. If it did not, the removal vectors would all fail for the
        // mundane reason that there is nothing to remove, and a reviewer would
        // have no way to tell that from a genuine removal defect. This vector
        // is the discriminator.
        vectors.Add(new ConformanceVector(
            "removal/fixture-was-installed",
            "true",
            fs.Find("ProgramData", "AI-Dev-OS", "Stage17-Proof", Token) is not null
                ? "true"
                : "false"));

        TransactionReport removed = InstallTransaction.Remove(
            fs,
            Token,
            ReviewedProofModeAuthorization.IssueForReviewedBoundedProof());
        vectors.Add(new ConformanceVector(
            "removal/happy-path",
            "none:",
            StepAndCode(removed)));
        vectors.Add(new ConformanceVector(
            "removal/leaf-is-gone",
            "true",
            fs.Find("ProgramData", "AI-Dev-OS", "Stage17-Proof", Token) is null ? "true" : "false"));

        // C:\ProgramData is never removed. It is not reachable by any code path
        // in the removal, which is stronger than a check that could be deleted:
        // the component list the removal walks does not contain it.
        vectors.Add(new ConformanceVector(
            "removal/program-data-still-present",
            "true",
            fs.Find("ProgramData") is not null ? "true" : "false"));

        // The shared ancestors survive too. This transaction cannot prove it
        // created them, so it does not remove them: "only if this transaction
        // created them" resolves to "not" whenever creation is unproven, and an
        // empty directory an operator can inspect is a better outcome than a
        // deletion nobody can justify.
        vectors.Add(new ConformanceVector(
            "removal/shared-ancestors-are-retained-when-creation-is-unproven",
            "true:true",
            string.Concat(
                fs.Find("ProgramData", ProofConfiguration.InstallRootFirstComponent) is not null
                    ? "true" : "false",
                ":",
                fs.Find(
                    "ProgramData",
                    ProofConfiguration.InstallRootFirstComponent,
                    ProofConfiguration.InstallRootSecondComponent) is not null
                    ? "true" : "false")));
        vectors.Add(new ConformanceVector(
            "removal/closes-every-handle",
            "0",
            fs.OpenHandleCount.ToString(CultureInfo.InvariantCulture)));

        // Manifests are deleted LAST, so an interrupted removal is still
        // recognizable. The sequence is pinned rather than described.
        vectors.Add(new ConformanceVector(
            "removal/deletes-the-manifest-last",
            ExpectedRemovalDeletionOrder,
            DeletionOrderOf(fs)));

        SimulatedFileSystem unexpected = Installed();
        SimulatedNode? leaf = unexpected.Find("ProgramData", "AI-Dev-OS", "Stage17-Proof", Token);
        if (leaf is not null)
        {
            unexpected.PlantFile(leaf, "planted.dll", [7, 7, 7]);
        }
        vectors.Add(new ConformanceVector(
            "removal/unexpected-entry-is-refused-not-deleted",
            "removal-unexpected-entry:enumerate-leaf",
            StepAndCode(InstallTransaction.Remove(
                unexpected,
                Token,
                ReviewedProofModeAuthorization.IssueForReviewedBoundedProof()))));
        vectors.Add(new ConformanceVector(
            "removal/unexpected-entry-survives-the-refusal",
            "true",
            unexpected.Find("ProgramData", "AI-Dev-OS", "Stage17-Proof", Token, "planted.dll") is not null
                ? "true"
                : "false"));

        // A substituted manifest can at most name a different token, and a
        // different token derives a different, non-existent leaf.
        SimulatedFileSystem substituted = Installed();
        ReplaceManifest(
            substituted,
            "{\"candidateId\":\"x\",\"files\":[]," +
            "\"manifestKind\":\"ai-dev-os-stage17-proof-installed-manifest\"," +
            "\"runToken\":\"" + OtherToken + "\",\"schemaVersion\":1}");
        vectors.Add(new ConformanceVector(
            "removal/substituted-manifest-is-refused",
            "removal-token-mismatch:read-installed-manifest",
            StepAndCode(InstallTransaction.Remove(
                substituted,
                Token,
                ReviewedProofModeAuthorization.IssueForReviewedBoundedProof()))));

        SimulatedFileSystem malformed = Installed();
        ReplaceManifest(malformed, "not json");
        vectors.Add(new ConformanceVector(
            "removal/malformed-manifest-is-refused",
            "removal-record-schema-invalid:read-installed-manifest",
            StepAndCode(InstallTransaction.Remove(
                malformed,
                Token,
                ReviewedProofModeAuthorization.IssueForReviewedBoundedProof()))));

        vectors.Add(new ConformanceVector(
            "removal/unknown-token-finds-nothing",
            "native-not-found:open-removal-component",
            StepAndCode(InstallTransaction.Remove(
                Installed(),
                OtherToken,
                ReviewedProofModeAuthorization.IssueForReviewedBoundedProof()))));
    }

    private static SimulatedFileSystem Installed()
    {
        SimulatedFileSystem fs = new(null);
        fs.PopulateSource(ProofConfiguration.SelfTestFixtureCandidate.FileNames, FixtureContent);
        _ = InstallTransaction.Install(
            fs,
            Token,
            ProofConfiguration.SelfTestFixtureCandidate,
            SimulatedFileSystem.SourcePath,
            ReviewedProofModeAuthorization.IssueForReviewedBoundedProof());
        return fs;
    }

    /// <summary>
    /// Replaces the installed manifest's bytes, tolerating a fixture whose
    /// install did not complete.
    ///
    /// The tolerance is not politeness. When a guard is deliberately removed to
    /// check that its removal is observable, the fixture install often fails as
    /// a side effect; if this helper dereferenced a missing leaf the self-test
    /// would crash with a null reference instead of reporting a failing vector,
    /// and a crash tells a reviewer that SOMETHING broke rather than WHICH
    /// guard was doing the work. Two of the fifteen reintroduction probes in
    /// this checkpoint did exactly that before this was fixed.
    /// </summary>
    private static void ReplaceManifest(SimulatedFileSystem fs, string manifestText)
    {
        SimulatedNode? leaf = fs.Find("ProgramData", "AI-Dev-OS", "Stage17-Proof", Token);
        if (leaf is null ||
            !leaf.Children.TryGetValue(
                ProofConfiguration.InstalledManifestFileName,
                out SimulatedNode? manifest))
        {
            return;
        }

        manifest.Content = Utf8.GetBytes(manifestText);
    }

    private static string DeletionOrderOf(SimulatedFileSystem fs)
    {
        List<string> order = [];
        bool sawDelete = false;
        string? pendingComponent = null;
        foreach (CanonicalObject entry in fs.OperationLog)
        {
            string? operation = null;
            string? component = null;
            foreach (KeyValuePair<string, CanonicalValue> member in entry.Members)
            {
                if (string.Equals(member.Key, "op", StringComparison.Ordinal))
                {
                    operation = member.Value.Text;
                }

                if (string.Equals(member.Key, "component", StringComparison.Ordinal))
                {
                    component = member.Value.Text;
                }
            }

            if (string.Equals(operation, "delete-through-handle", StringComparison.Ordinal))
            {
                sawDelete = true;
                order.Add(component ?? pendingComponent ?? "?");
            }

            pendingComponent = component ?? pendingComponent;
        }

        return sawDelete ? string.Join('|', order) : "no-deletions";
    }

    /// <summary>
    /// The exact native operation sequence of a successful install, pinned.
    ///
    /// Read it as the answer to "what does this component actually do":
    /// resolve the proof identity and the known folder; open the volume root
    /// once and check its facts; walk ProgramData relative to it; create
    /// AI-Dev-OS, Stage17-Proof, and the run-token leaf, reading back the facts
    /// and the security descriptor of each through the handle that created it;
    /// AccessCheck all four against the standard token; walk to the source root
    /// through its own retained chain; enumerate it; open, read, and measure
    /// each source file through a retained deny-write handle; re-read the
    /// facts of all four retained destination handles and require each to
    /// still report the identity it reported at open time; create, write,
    /// flush, and re-measure each destination file; then re-enumerate the leaf
    /// and re-measure, re-read the DACL of, and AccessCheck every installed
    /// file.
    ///
    /// There is no delete operation anywhere in an install, and nothing is
    /// re-opened by name after being created.
    ///
    /// Every <c>rewind-to-start</c> entry below is load-bearing, and the rule that
    /// makes it so is worth stating exactly, because an earlier revision got it
    /// wrong: a rewind appears if and only if an EARLIER operation on that same
    /// handle already advanced the offset.
    ///
    /// That is once per source file — after the read, before the measurement,
    /// since both go through the one handle — and once per destination file,
    /// since the write left the offset at end of file. An audit found both of
    /// those positions hashing zero bytes and digesting the empty string.
    ///
    /// It is NOT before the first read of a source file, and NOT in the final
    /// verification loop, for the same single reason in both cases: those handles
    /// were just opened, so their offset is already zero. An earlier revision
    /// rewound before the first source read as well, and a later audit was right
    /// that the call was decorative while its comment called it load-bearing —
    /// removing it changed nothing observable. It is gone, so the rule and the
    /// sequence now agree.
    /// </summary>
    private const string ExpectedInstallSequence =
        "resolve-proof-identity|resolve-known-folder|open-volume-root|query-facts|" +
        "open-relative|query-facts|query-facts|" +
        "open-relative|query-facts|query-security|query-facts|" +
        "open-relative|query-facts|query-security|query-facts|" +
        "open-relative|query-facts|query-security|query-facts|" +
        "access-check|access-check|access-check|access-check|" +
        "open-volume-root|query-facts|open-relative|query-facts|open-relative|query-facts|" +
        "list-directory|" +
        "open-relative|query-facts|read-through-handle|rewind-to-start|measure-file|" +
        "open-relative|query-facts|read-through-handle|rewind-to-start|measure-file|" +
        "query-facts|query-facts|query-facts|query-facts|" +
        "open-relative|write-through-handle|flush-buffers|rewind-to-start|measure-file|" +
        "open-relative|write-through-handle|flush-buffers|rewind-to-start|measure-file|" +
        "open-relative|write-through-handle|flush-buffers|rewind-to-start|measure-file|" +
        "open-relative|write-through-handle|flush-buffers|rewind-to-start|measure-file|" +
        "list-directory|" +
        "open-relative|measure-file|query-security|access-check|" +
        "open-relative|measure-file|query-security|access-check";

    /// <summary>
    /// The exact deletion order of a successful removal: payload files in
    /// ordinal order, then the install record, then the manifest, then the leaf
    /// directory itself. The manifest is LAST so an interrupted removal is
    /// still recognizable — a leaf that still has a manifest is a leaf whose
    /// removal did not finish.
    /// </summary>
    private const string ExpectedRemovalDeletionOrder =
        "alpha.dll|beta.exe|stage17-proof-install-record.json|stage17-proof-manifest.json|" +
        Token;
#endif

    private static string Label(string value)
    {
        if (value.Length == 0)
        {
            return "empty";
        }

        StringBuilder builder = new(value.Length);
        foreach (char character in value)
        {
            bool safe = (character >= 'a' && character <= 'z') ||
                        (character >= 'A' && character <= 'Z') ||
                        (character >= '0' && character <= '9') ||
                        character == '-' || character == '.';
            builder.Append(safe ? character : '_');
        }

        return builder.Length > 48 ? builder.ToString(0, 48) : builder.ToString();
    }
}

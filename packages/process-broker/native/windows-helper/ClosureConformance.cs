using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace AiDevOs.WindowsHelper;

/// <summary>
/// Read-only self-test vectors for ownership-bearing closure verification, the
/// process-creation boundary, bundle path resolution, and the two-factor
/// mutation gate.
///
/// Every vector runs entirely in memory. Nothing here opens a file, resolves a
/// real path, creates a process, or allocates any host resource: the filesystem
/// facts are described by <see cref="InMemoryPathFacts"/> and the closure bytes
/// by <see cref="InMemoryClosureSource"/>.
///
/// These vectors exist to make specific defects *fail*, not to describe good
/// behaviour in the abstract. Each one names the defect it detects.
/// </summary>
internal static class ClosureConformance
{
    private const string InstallRoot = @"C:\ProgramData\AI-Dev-OS\bundles";
    private const string Component = "windows-supervisor";
    private const string BundleVersion = "1.0.0";

    private static readonly UTF8Encoding Utf8 = new(encoderShouldEmitUTF8Identifier: false);

    private static string BundlePath =>
        string.Concat(InstallRoot, @"\", Component, @"\", BundleVersion, @"\", BundleRootResolver.RidDirectoryName);

    internal static void AddVectors(List<ConformanceVector> vectors)
    {
        AddLeaseVectors(vectors);
        AddBoundaryVectors(vectors);
        AddPathVectors(vectors);
        AddGateVectors(vectors);
    }

    // ----------------------------------------------------------------- lease

    private static ArtifactManifest Manifest()
    {
        if (!ArtifactManifestReader.TryParse(
            Utf8.GetBytes(CoreConformance.ManifestFixtureJson),
            out ArtifactManifest manifest,
            out _))
        {
            throw new InvalidOperationException("closure-conformance-fixture-unparsable");
        }

        return manifest;
    }

    private static InMemoryClosureSource GoodSource() =>
        new InMemoryClosureSource()
            .Add("alpha.dll", Utf8.GetBytes("123"))
            .Add("beta.exe", Utf8.GetBytes("1234"));

    private static InMemoryClosureSource SourceWith(
        ClosureSharePosture posture,
        ClosureMeasurementProvenance provenance) =>
        new InMemoryClosureSource(posture, provenance)
            .Add("alpha.dll", Utf8.GetBytes("123"))
            .Add("beta.exe", Utf8.GetBytes("1234"));

    private static ClosureSharePosture Posture(bool read, bool write, bool delete)
    {
        System.IO.FileShare share = System.IO.FileShare.None;
        if (read)
        {
            share |= System.IO.FileShare.Read;
        }

        if (write)
        {
            share |= System.IO.FileShare.Write;
        }

        if (delete)
        {
            share |= System.IO.FileShare.Delete;
        }

        return ClosureSharePosture.FromFileShare(share);
    }

    private static string Acquire(IVerifiedClosureSource source)
    {
        using ClosureLeaseResult result = VerifiedClosureLease.Acquire(Manifest(), source);
        if (result.Lease is not { } lease)
        {
            return string.Concat("refused:", ProtocolNames.Of(result.Code));
        }

        return string.Concat(
            "leased:",
            lease.HandleCount.ToString(CultureInfo.InvariantCulture),
            ":",
            ProtocolNames.Of(lease.AssertUsable()));
    }

    private static void AddLeaseVectors(List<ConformanceVector> vectors)
    {
        vectors.Add(new ConformanceVector(
            "closure/lease-acquired-over-exact-closure",
            "leased:2:none",
            Acquire(GoodSource())));

        // DEFECT DETECTED: verification handles disposed before they are used.
        // A lease that closed its handles after hashing reports the bytes were
        // right at some past instant, which is precisely the claim ADR 0017
        // section 6.5 step 4 says is not good enough.
        vectors.Add(new ConformanceVector(
            "closure/lease-retains-handles-after-measurement",
            "true",
            RetainsHandlesAfterMeasurement()));

        // DEFECT DETECTED: the digest was taken from a path rather than through
        // the held handle.
        vectors.Add(new ConformanceVector(
            "closure/refuses-measurement-not-through-handle",
            "refused:closure-measurement-not-through-handle",
            Acquire(SourceWith(
                ClosureSharePosture.DenyWriteAndDelete,
                ClosureMeasurementProvenance.ByPath))));
        vectors.Add(new ConformanceVector(
            "closure/refuses-unknown-measurement-provenance",
            "refused:closure-measurement-not-through-handle",
            Acquire(SourceWith(
                ClosureSharePosture.DenyWriteAndDelete,
                ClosureMeasurementProvenance.Unknown))));

        // DEFECT DETECTED: sharing that permits write, or permits delete. Both
        // reopen the substitution window the held handle exists to close.
        vectors.Add(new ConformanceVector(
            "closure/refuses-share-mode-permitting-write",
            "refused:closure-share-mode-permits-write",
            Acquire(SourceWith(
                Posture(read: true, write: true, delete: false),
                ClosureMeasurementProvenance.ThroughHeldHandle))));
        vectors.Add(new ConformanceVector(
            "closure/refuses-share-mode-permitting-delete",
            "refused:closure-share-mode-permits-delete",
            Acquire(SourceWith(
                Posture(read: true, write: false, delete: true),
                ClosureMeasurementProvenance.ThroughHeldHandle))));

        // DEFECT DETECTED: an extra file in the closure is ignored.
        vectors.Add(new ConformanceVector(
            "closure/refuses-extra-closure-file",
            "refused:manifest-file-unexpected",
            Acquire(GoodSource().Add("gamma.dll", Utf8.GetBytes("x")))));
        vectors.Add(new ConformanceVector(
            "closure/refuses-missing-closure-file",
            "refused:manifest-file-missing",
            Acquire(new InMemoryClosureSource().Add("alpha.dll", Utf8.GetBytes("123")))));
        vectors.Add(new ConformanceVector(
            "closure/refuses-size-mismatch",
            "refused:manifest-file-size-mismatch",
            Acquire(new InMemoryClosureSource()
                .Add("alpha.dll", Utf8.GetBytes("1234"))
                .Add("beta.exe", Utf8.GetBytes("1234")))));
        vectors.Add(new ConformanceVector(
            "closure/refuses-digest-mismatch",
            "refused:manifest-file-digest-mismatch",
            Acquire(new InMemoryClosureSource()
                .Add("alpha.dll", Utf8.GetBytes("xyz"))
                .Add("beta.exe", Utf8.GetBytes("1234")))));

        vectors.Add(new ConformanceVector(
            "closure/failed-acquisition-leaks-no-open-handle",
            "true",
            FailedAcquisitionClosesEverything()));
        // DEFECT DETECTED: the real file handle is opened with sharing that
        // permits write or delete. The in-memory suite cannot observe the share
        // mode of a file it never opens, so the posture is asserted directly.
        vectors.Add(new ConformanceVector(
            "closure/win32-handle-denies-write-and-delete",
            "{\"permitsDelete\":false,\"permitsRead\":true,\"permitsWrite\":false}",
            CanonicalJson.SerializeToString(Win32FileClosureHandle.RequiredPosture.ToCanonical())));
        vectors.Add(new ConformanceVector(
            "closure/disposed-lease-is-not-usable",
            "closure-lease-not-held",
            DisposedLeaseVerdict()));
    }

    /// <summary>
    /// Proves the lease still holds every handle open after the whole closure
    /// has been measured. If measurement disposed its handles — the defect this
    /// replaced — the lease would report a closed handle here.
    /// </summary>
    private static string RetainsHandlesAfterMeasurement()
    {
        using ClosureLeaseResult result = VerifiedClosureLease.Acquire(Manifest(), GoodSource());
        if (result.Lease is not { } lease)
        {
            return "acquire-failed";
        }

        {
            if (!lease.TryFindHandle("alpha.dll", out ClosureHandle alpha) ||
                !lease.TryFindHandle("beta.exe", out ClosureHandle beta))
            {
                return "handle-missing";
            }

            return alpha.IsOpen && beta.IsOpen && lease.AssertUsable() == RefusalCode.None
                ? "true"
                : "false";
        }
    }

    private static string FailedAcquisitionClosesEverything()
    {
        // The second member is wrong, so acquisition fails after the first
        // handle has already been opened. That first handle must not survive.
        TrackingClosureSource source = new();
        using (ClosureLeaseResult result = VerifiedClosureLease.Acquire(Manifest(), source))
        {
            if (result.IsHeld)
            {
                return "unexpectedly-acquired";
            }
        }

        return source.AnyHandleStillOpen() ? "false" : "true";
    }

    private static string DisposedLeaseVerdict()
    {
        using ClosureLeaseResult result = VerifiedClosureLease.Acquire(Manifest(), GoodSource());
        if (result.Lease is not { } lease)
        {
            return "acquire-failed";
        }

        lease.Dispose();
        return ProtocolNames.Of(lease.AssertUsable());
    }

    /// <summary>A source that remembers every handle it produced.</summary>
    private sealed class TrackingClosureSource : IVerifiedClosureSource
    {
        private readonly List<ClosureHandle> issued = [];

        public IReadOnlyList<string> EnumerateFileNames() => ["alpha.dll", "beta.exe"];

        public bool TryOpenRetained(string name, out ClosureHandle handle, out RefusalCode code)
        {
            byte[] content = string.Equals(name, "alpha.dll", StringComparison.Ordinal)
                ? Utf8.GetBytes("123")
                : Utf8.GetBytes("wrong-bytes-entirely");
            handle = new InMemoryClosureHandle(name, content);
            issued.Add(handle);
            code = RefusalCode.None;
            return true;
        }

        internal bool AnyHandleStillOpen()
        {
            foreach (ClosureHandle handle in issued)
            {
                if (handle.IsOpen)
                {
                    return true;
                }
            }

            return false;
        }
    }

    // -------------------------------------------------------------- boundary

    private static ResolvedBundleRoot Root() =>
        ResolvedBundleRoot.ForTesting(
            InstallRoot,
            BundlePath,
            Component,
            BundleVersion,
            ["alpha.dll", "beta.exe"]);

    private static void AddBoundaryVectors(List<ConformanceVector> vectors)
    {
        vectors.Add(new ConformanceVector(
            "boundary/authorizes-verified-image",
            "authorized:" + BundlePath + @"\beta.exe",
            Authorize("beta.exe", disposeLeaseFirst: false)));

        // DEFECT DETECTED: an unverified path reaches process creation. There is
        // no path-taking overload at all, so the only way to ask for something
        // outside the closure is by name — and a name that is not a verified
        // closure member is refused.
        vectors.Add(new ConformanceVector(
            "boundary/refuses-image-outside-verified-closure",
            "refused:closure-image-not-verified",
            Authorize("cmd.exe", disposeLeaseFirst: false)));
        vectors.Add(new ConformanceVector(
            "boundary/refuses-path-shaped-image-name",
            "refused:closure-image-not-verified",
            Authorize(@"..\..\windows\system32\cmd.exe", disposeLeaseFirst: false)));

        // DEFECT DETECTED: the lease was disposed before the creation call.
        vectors.Add(new ConformanceVector(
            "boundary/refuses-when-lease-already-disposed",
            "refused:closure-lease-not-held",
            Authorize("beta.exe", disposeLeaseFirst: true)));

        // DEFECT DETECTED: the lease was disposed between authorization and the
        // creation call. Authorizing once at setup time is not enough; the check
        // has to be re-asserted at the last instruction.
        vectors.Add(new ConformanceVector(
            "boundary/refuses-when-lease-disposed-after-authorization",
            "closure-lease-not-held",
            AuthorizeThenDisposeThenCheck()));

        vectors.Add(new ConformanceVector(
            "boundary/permits-creation-while-lease-held",
            "none",
            AuthorizeThenCheck()));

        // DEFECT DETECTED: the child's reported identity differs from the
        // verified manifest and is tolerated.
        ArtifactManifest manifest = Manifest();
        string fingerprint = manifest.Fingerprint();
        vectors.Add(new ConformanceVector(
            "boundary/child-identity-matches",
            "none",
            CrossCheck(manifest, fingerprint, manifest.Component, manifest.SourceVersion, manifest.ProtocolVersion, manifest.BuildRecipeVersion, fingerprint)));
        vectors.Add(new ConformanceVector(
            "boundary/refuses-child-reporting-other-component",
            "child-identity-mismatch",
            CrossCheck(manifest, fingerprint, "windows-helper", manifest.SourceVersion, manifest.ProtocolVersion, manifest.BuildRecipeVersion, fingerprint)));
        vectors.Add(new ConformanceVector(
            "boundary/refuses-child-reporting-other-source-version",
            "child-identity-mismatch",
            CrossCheck(manifest, fingerprint, manifest.Component, "2.0.0", manifest.ProtocolVersion, manifest.BuildRecipeVersion, fingerprint)));
        vectors.Add(new ConformanceVector(
            "boundary/refuses-child-reporting-other-protocol",
            "child-identity-mismatch",
            CrossCheck(manifest, fingerprint, manifest.Component, manifest.SourceVersion, 2, manifest.BuildRecipeVersion, fingerprint)));
        vectors.Add(new ConformanceVector(
            "boundary/refuses-child-reporting-other-build-recipe",
            "child-identity-mismatch",
            CrossCheck(manifest, fingerprint, manifest.Component, manifest.SourceVersion, manifest.ProtocolVersion, 2, fingerprint)));
        vectors.Add(new ConformanceVector(
            "boundary/refuses-child-reporting-other-manifest-fingerprint",
            "child-identity-mismatch",
            CrossCheck(manifest, fingerprint, manifest.Component, manifest.SourceVersion, manifest.ProtocolVersion, manifest.BuildRecipeVersion, new string('0', 64))));
    }

    private static string Authorize(string imageName, bool disposeLeaseFirst)
    {
        using ClosureLeaseResult result = VerifiedClosureLease.Acquire(Manifest(), GoodSource());
        if (result.Lease is not { } lease)
        {
            return "acquire-failed";
        }

        {
            if (disposeLeaseFirst)
            {
                lease.Dispose();
            }

            if (!ProcessCreationBoundary.TryAuthorize(
                lease,
                Root(),
                imageName,
                out VerifiedImageReference image,
                out RefusalCode code))
            {
                return string.Concat("refused:", ProtocolNames.Of(code));
            }

            return string.Concat("authorized:", image.AbsolutePath);
        }
    }

    private static string AuthorizeThenDisposeThenCheck()
    {
        using ClosureLeaseResult result = VerifiedClosureLease.Acquire(Manifest(), GoodSource());
        if (result.Lease is not { } lease)
        {
            return "acquire-failed";
        }

        {
            if (!ProcessCreationBoundary.TryAuthorize(lease, Root(), "beta.exe", out VerifiedImageReference image, out _))
            {
                return "authorize-failed";
            }

            lease.Dispose();
            return ProtocolNames.Of(ProcessCreationBoundary.AssertCreationPermitted(image));
        }
    }

    private static string AuthorizeThenCheck()
    {
        using ClosureLeaseResult result = VerifiedClosureLease.Acquire(Manifest(), GoodSource());
        if (result.Lease is not { } lease)
        {
            return "acquire-failed";
        }

        {
            if (!ProcessCreationBoundary.TryAuthorize(lease, Root(), "beta.exe", out VerifiedImageReference image, out _))
            {
                return "authorize-failed";
            }

            return ProtocolNames.Of(ProcessCreationBoundary.AssertCreationPermitted(image));
        }
    }

    private static string CrossCheck(
        ArtifactManifest manifest,
        string expectedFingerprint,
        string component,
        string sourceVersion,
        int protocolVersion,
        int buildRecipeVersion,
        string reportedFingerprint) =>
        ProtocolNames.Of(ProcessCreationBoundary.CrossCheckChildIdentity(
            manifest,
            new ReportedComponentIdentity(
                component,
                sourceVersion,
                protocolVersion,
                buildRecipeVersion,
                reportedFingerprint),
            expectedFingerprint));

    // ------------------------------------------------------------------ path

    private static InMemoryPathFacts PlainLayout()
    {
        InMemoryPathFacts facts = new();
        facts.AddDirectory(InstallRoot);
        facts.AddDirectory(string.Concat(InstallRoot, @"\", Component));
        facts.AddDirectory(string.Concat(InstallRoot, @"\", Component, @"\", BundleVersion));
        facts.AddEntries(BundlePath, "alpha.dll", "beta.exe");
        return facts;
    }

    private static string Resolve(IPathFacts facts, string root, string component, string version)
    {
        if (!BundleRootResolver.TryResolve(
            facts,
            root,
            component,
            version,
            out ResolvedBundleRoot resolved,
            out RefusalCode code))
        {
            return string.Concat("refused:", ProtocolNames.Of(code));
        }

        return string.Concat(
            "resolved:",
            resolved.EnumeratedFileNames.Count.ToString(CultureInfo.InvariantCulture));
    }

    private static void AddPathVectors(List<ConformanceVector> vectors)
    {
        vectors.Add(new ConformanceVector(
            "path/resolves-exact-versioned-bundle",
            "resolved:2",
            Resolve(PlainLayout(), InstallRoot, Component, BundleVersion)));

        // DEFECT DETECTED: a reparse point anywhere in the chain redirects the
        // path after it was checked.
        InMemoryPathFacts leafLink = PlainLayout();
        leafLink.AddReparsePoint(BundlePath);
        vectors.Add(new ConformanceVector(
            "path/refuses-reparse-point-at-leaf",
            "refused:artifact-path-reparse-point",
            Resolve(leafLink, InstallRoot, Component, BundleVersion)));

        InMemoryPathFacts midLink = PlainLayout();
        midLink.AddReparsePoint(string.Concat(InstallRoot, @"\", Component));
        vectors.Add(new ConformanceVector(
            "path/refuses-reparse-point-at-intermediate-component",
            "refused:artifact-path-reparse-point",
            Resolve(midLink, InstallRoot, Component, BundleVersion)));

        InMemoryPathFacts rootLink = PlainLayout();
        rootLink.AddReparsePoint(InstallRoot);
        vectors.Add(new ConformanceVector(
            "path/refuses-reparse-point-at-approved-root",
            "refused:artifact-path-reparse-point",
            Resolve(rootLink, InstallRoot, Component, BundleVersion)));

        // DEFECT DETECTED: a parent or sibling path escapes the approved root.
        vectors.Add(new ConformanceVector(
            "path/refuses-parent-escape-in-component",
            "refused:artifact-path-normalization-ambiguous",
            Resolve(PlainLayout(), InstallRoot, "..", BundleVersion)));
        vectors.Add(new ConformanceVector(
            "path/refuses-parent-escape-in-version",
            "refused:artifact-path-normalization-ambiguous",
            Resolve(PlainLayout(), InstallRoot, Component, @"..\..\..\windows")));
        vectors.Add(new ConformanceVector(
            "path/refuses-separator-in-version",
            "refused:artifact-path-normalization-ambiguous",
            Resolve(PlainLayout(), InstallRoot, Component, @"1.0.0\..\9.9.9")));

        // DEFECT DETECTED: two spellings of one path.
        vectors.Add(new ConformanceVector(
            "path/refuses-short-name-alias-in-root",
            "refused:artifact-path-normalization-ambiguous",
            Resolve(PlainLayout(), @"C:\PROGRA~1\AI-Dev-OS", Component, BundleVersion)));
        vectors.Add(new ConformanceVector(
            "path/refuses-dot-segment-in-root",
            "refused:artifact-path-normalization-ambiguous",
            Resolve(PlainLayout(), @"C:\ProgramData\.\AI-Dev-OS", Component, BundleVersion)));
        vectors.Add(new ConformanceVector(
            "path/refuses-relative-root",
            "refused:artifact-root-unresolvable",
            Resolve(PlainLayout(), @"bundles", Component, BundleVersion)));
        vectors.Add(new ConformanceVector(
            "path/refuses-unknown-component",
            "refused:manifest-identity-mismatch",
            Resolve(PlainLayout(), InstallRoot, "windows-feasibility-probe", BundleVersion)));
        vectors.Add(new ConformanceVector(
            "path/refuses-absent-bundle",
            "refused:artifact-root-unresolvable",
            Resolve(new InMemoryPathFacts(), InstallRoot, Component, BundleVersion)));

        // DEFECT DETECTED: case-only duplicates in the installed directory.
        InMemoryPathFacts caseDuplicate = new();
        caseDuplicate.AddDirectory(InstallRoot);
        caseDuplicate.AddDirectory(string.Concat(InstallRoot, @"\", Component));
        caseDuplicate.AddDirectory(string.Concat(InstallRoot, @"\", Component, @"\", BundleVersion));
        caseDuplicate.AddEntries(BundlePath, "alpha.dll", "ALPHA.DLL");
        vectors.Add(new ConformanceVector(
            "path/refuses-case-only-duplicate-entry",
            "refused:manifest-file-duplicate",
            Resolve(caseDuplicate, InstallRoot, Component, BundleVersion)));

        InMemoryPathFacts unsafeName = new();
        unsafeName.AddDirectory(InstallRoot);
        unsafeName.AddDirectory(string.Concat(InstallRoot, @"\", Component));
        unsafeName.AddDirectory(string.Concat(InstallRoot, @"\", Component, @"\", BundleVersion));
        unsafeName.AddEntries(BundlePath, "alpha.dll", "NUL.dll");
        vectors.Add(new ConformanceVector(
            "path/refuses-reserved-device-entry-name",
            "refused:manifest-file-name-invalid",
            Resolve(unsafeName, InstallRoot, Component, BundleVersion)));

        // Defence-in-depth predicate, pinned directly because no composition
        // reachable through TryResolve can currently violate it.
        vectors.Add(new ConformanceVector(
            "path/inside-root-accepts-child",
            "true",
            BundleRootResolver.IsPathInsideRoot(InstallRoot, BundlePath) ? "true" : "false"));
        vectors.Add(new ConformanceVector(
            "path/inside-root-rejects-identical-path",
            "false",
            BundleRootResolver.IsPathInsideRoot(InstallRoot, InstallRoot) ? "true" : "false"));
        vectors.Add(new ConformanceVector(
            "path/inside-root-rejects-parent",
            "false",
            BundleRootResolver.IsPathInsideRoot(InstallRoot, @"C:\ProgramData\AI-Dev-OS") ? "true" : "false"));
        vectors.Add(new ConformanceVector(
            "path/inside-root-rejects-sibling-sharing-a-string-prefix",
            "false",
            BundleRootResolver.IsPathInsideRoot(InstallRoot, InstallRoot + @"-evileta.exe") ? "true" : "false"));
        vectors.Add(new ConformanceVector(
            "path/inside-root-rejects-unrelated-root",
            "false",
            BundleRootResolver.IsPathInsideRoot(InstallRoot, @"C:\Windows\System32\cmd.exe") ? "true" : "false"));
        vectors.Add(new ConformanceVector(
            "path/member-path-is-a-direct-child",
            "true:" + BundlePath + @"\alpha.dll",
            MemberPath("alpha.dll")));
        vectors.Add(new ConformanceVector(
            "path/member-path-refuses-separator",
            "false:manifest-file-name-invalid",
            MemberPath(@"sub\alpha.dll")));
        vectors.Add(new ConformanceVector(
            "path/member-path-refuses-parent-segment",
            "false:manifest-file-name-invalid",
            MemberPath("..")));
    }

    private static string MemberPath(string name)
    {
        if (!Root().TryResolveMemberPath(name, out string absolute, out RefusalCode code))
        {
            return string.Concat("false:", ProtocolNames.Of(code));
        }

        return string.Concat("true:", absolute);
    }

    // ------------------------------------------------------------------ gate

    private static void AddGateVectors(List<ConformanceVector> vectors)
    {
        vectors.Add(new ConformanceVector(
            "gate/build-flavor-is-sealed",
            "sealed",
            MutationGate.BuildFlavor));
        vectors.Add(new ConformanceVector(
            "gate/proof-mode-not-compiled-in",
            "false",
            MutationGate.ProofModeCompiledIn ? "true" : "false"));
        vectors.Add(new ConformanceVector(
            "gate/unauthorized-caller-is-refused",
            "mutating-operations-structurally-disabled",
            ProtocolNames.Of(MutationGate.Authorize(null))));
        vectors.Add(new ConformanceVector(
            "gate/canonical-state",
            "{\"buildFlavor\":\"sealed\",\"mutatingOperationsPermitted\":false," +
            "\"proofModeCompiledIn\":false," +
            "\"unauthorizedRefusal\":\"mutating-operations-structurally-disabled\"}",
            CanonicalJson.SerializeToString(MutationGate.ToCanonical())));
    }
}

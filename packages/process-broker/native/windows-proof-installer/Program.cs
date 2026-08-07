using System;
using System.Collections.Generic;
using System.Text;

namespace AiDevOs.WindowsProofInstaller;

/// <summary>
/// Entry point for the proof-only native handle-relative installer and remover
/// (ADR 0018 section 2).
///
/// Five commands, two of which are read-only and can be run by anyone:
///
///   describe-artifact  this component's own fixed identity and build flavour;
///   self-test          the in-memory conformance suite;
///   plan               a pure derivation of what an install WOULD do — no
///                      known folder is resolved, no handle is opened, and no
///                      byte is read;
///   install            gated; requires a ReviewedProofModeAuthorization by
///                      signature, which a sealed build cannot construct;
///   remove             gated identically.
///
/// There is no shell, no PATH lookup, no environment read, no current-directory
/// read, no DNS, no network, no registry access, no service, no scheduled task,
/// no provider or credential access, no plugin surface, no runtime download,
/// and no embedded secret or signing key.
///
/// The two gated commands are the only ones that can touch the filesystem at
/// all, and in a sealed build they refuse before examining a single argument.
///
/// What a REVIEWED-PROOF build does in this checkpoint has to be stated per
/// command, because the two are not inert for the same reason and an earlier
/// version of this comment gave one reason for both:
///
///   install  refuses STRUCTURALLY. The candidate is looked up before any
///            filesystem object is touched, and the compiled-in installable
///            table is empty by decision, so every candidate identifier is
///            unknown and there is nothing an operator can name.
///
///   remove   takes no candidate, so nothing on its path consults that table.
///            It resolves the known folder, opens the volume root, and walks
///            toward the run-token leaf. It finds nothing and refuses, but it
///            refuses because no matching leaf EXISTS — a fact about the host,
///            not a property of the build. Its blast radius is bounded
///            structurally instead: the only deletion candidates are the
///            components it recomputed from the token, and
///            <c>C:\ProgramData</c> is not among them.
/// </summary>
internal static class Program
{
    private const int SuccessExitCode = 0;
    private const int SelfTestFailedExitCode = 1;
    private const int RefusedExitCode = 2;
    private const int UnknownCommandExitCode = 64;

    private static readonly UTF8Encoding Utf8 = new(encoderShouldEmitUTF8Identifier: false);

    internal static int Main(string[] args)
    {
        if (args is null || args.Length == 0)
        {
            return Refuse(RefusalCode.UnknownCommand, UnknownCommandExitCode);
        }

        return args[0] switch
        {
            "self-test" => args.Length == 1
                ? RunSelfTest()
                : Refuse(RefusalCode.ArgumentInvalid, UnknownCommandExitCode),
            "describe-artifact" => args.Length == 1
                ? DescribeArtifact()
                : Refuse(RefusalCode.ArgumentInvalid, UnknownCommandExitCode),
            "plan" => RunPlan(args),
            "install" => RunInstall(args),
            "remove" => RunRemove(args),
            _ => Refuse(RefusalCode.UnknownCommand, UnknownCommandExitCode),
        };
    }

    private static int RunSelfTest()
    {
        ConformanceReport report = InstallerConformance.Run();

        // MEASURED, not asserted. Both of these were hardcoded `false`, which
        // made the packaging script's `hostStateCreated !== false` check an
        // examination of a compile-time literal — a check that could never fire,
        // about the one property most worth checking. They are now read from
        // counters the native adapter increments in its own constructor and its
        // own open path, so "the self-test touched nothing" is a reading rather
        // than a claim.
        int instantiations = NativeHandleRelativeFileSystem.InstantiationCount;
        int nativeOpens = NativeHandleRelativeFileSystem.NativeOpenAttemptCount;
        CanonicalObject result = MutationGate.Describe(new CanonicalObject())
            .Set("component", ComponentIdentity.ComponentName)
            .Set("conformanceDigest", report.Digest)
            .Set("failedVectorCount", report.FailedCount)
            .Set("failedVectorDetail", report.FailedDetail)
            .Set("failedVectors", report.FailedNames)
            .Set("hostStateCreated", nativeOpens != 0)
            .Set("installableCandidateCount", ProofConfiguration.Installable.Count)
            .Set("mutatingOperationsPermitted", MutationGate.MutatingOperationsPermitted)
            .Set("nativeFileSystemInstantiated", instantiations != 0)
            .Set("nativeOpenAttempts", nativeOpens)
            .Set("productionEligible", ComponentIdentity.ProductionEligible)
            .Set("status", report.Passed ? "passed" : "failed")
            .Set("suite", report.Suite)
            .Set("vectorCount", report.Count);

        Write(result);
        return report.Passed ? SuccessExitCode : SelfTestFailedExitCode;
    }

    private static int DescribeArtifact()
    {
        CanonicalObject result = MutationGate.Describe(new CanonicalObject())
            .Set("architecture", ComponentIdentity.Architecture)
            .Set("buildRecipeVersion", ComponentIdentity.BuildRecipeVersion)
            .Set("component", ComponentIdentity.ComponentName)
            .Set("installRootFirstComponent", ProofConfiguration.InstallRootFirstComponent)
            .Set("installRootSecondComponent", ProofConfiguration.InstallRootSecondComponent)
            .Set("installableCandidateCount", ProofConfiguration.Installable.Count)
            .Set("platform", ComponentIdentity.Platform)
            .Set("productionEligible", ComponentIdentity.ProductionEligible)
            .Set("purpose", ComponentIdentity.PurposeCode)
            .Set("rid", ComponentIdentity.RuntimeIdentifier)
            .Set("role", ComponentIdentity.Role)
            .Set("signerState", ComponentIdentity.SignerState)
            .Set("sourceVersion", ComponentIdentity.SourceVersion)
            .Set("status", "described");

        Write(result);
        return SuccessExitCode;
    }

    /// <summary>
    /// Composes and prints the plan for human review. Pure: it derives
    /// everything from compiled-in configuration plus the run token, and
    /// touches no filesystem at all. ADR 0018 section 1 leaves plan composition
    /// and display to a caller; it is done here instead so the plan a reviewer
    /// reads is produced by the same code that would act on it.
    /// </summary>
    private static int RunPlan(string[] args)
    {
        Outcome<Arguments> parsed = Arguments.Parse(args, requireSource: false);
        if (!parsed.Ok || parsed.Value is null)
        {
            return Refuse(parsed.Refusal, RefusedExitCode);
        }

        Outcome<ProofCandidate> candidate =
            ProofConfiguration.FindInstallable(parsed.Value.CandidateId);
        if (!candidate.Ok || candidate.Value is null)
        {
            // The expected state in this checkpoint: the installable table is
            // empty by decision, so every candidate identifier is unknown.
            return Refuse(candidate.Refusal, RefusedExitCode);
        }

        Outcome<InstallPlan> plan = InstallPlan.Derive(parsed.Value.RunToken, candidate.Value);
        if (!plan.Ok || plan.Value is null)
        {
            return Refuse(plan.Refusal, RefusedExitCode);
        }

        Write(MutationGate.Describe(new CanonicalObject())
            .Set("candidate", CanonicalValue.Of(candidate.Value.ToCanonical()))
            .Set("component", ComponentIdentity.ComponentName)
            .Set("filesystemTouched", false)
            .Set("plan", CanonicalValue.Of(plan.Value.ToCanonical()))
            .Set("status", "planned"));
        return SuccessExitCode;
    }

    private static int RunInstall(string[] args)
    {
        Outcome<Arguments> parsed = Arguments.Parse(args, requireSource: true);
        if (!parsed.Ok || parsed.Value is null)
        {
            return Refuse(parsed.Refusal, RefusedExitCode);
        }

        Outcome<ProofCandidate> candidate =
            ProofConfiguration.FindInstallable(parsed.Value.CandidateId);
        if (!candidate.Ok || candidate.Value is null)
        {
            return Refuse(candidate.Refusal, RefusedExitCode);
        }

        using NativeHandleRelativeFileSystem fs = new();
        TransactionReport report = InstallTransaction.Install(
            fs,
            parsed.Value.RunToken,
            candidate.Value,
            parsed.Value.SourceRoot,
            Authorization());
        Write(MutationGate.Describe(report.ToCanonical())
            .Set("component", ComponentIdentity.ComponentName));
        return report.Succeeded ? SuccessExitCode : RefusedExitCode;
    }

    private static int RunRemove(string[] args)
    {
        Outcome<Arguments> parsed = Arguments.Parse(args, requireSource: false, requireCandidate: false);
        if (!parsed.Ok || parsed.Value is null)
        {
            return Refuse(parsed.Refusal, RefusedExitCode);
        }

        using NativeHandleRelativeFileSystem fs = new();
        TransactionReport report = InstallTransaction.Remove(fs, parsed.Value.RunToken, Authorization());
        Write(MutationGate.Describe(report.ToCanonical())
            .Set("component", ComponentIdentity.ComponentName));
        return report.Succeeded ? SuccessExitCode : RefusedExitCode;
    }

    /// <summary>
    /// The single place an authorization value is produced.
    ///
    /// In a sealed build the accessor does not exist, so this returns
    /// <see langword="null"/> and both mutating commands refuse at the gate.
    /// There is no argument, environment variable, or configuration that
    /// changes which branch is compiled.
    /// </summary>
    private static ReviewedProofModeAuthorization? Authorization()
    {
#if AIDEVOS_STAGE17_REVIEWED_PROOF_MODE
        return ReviewedProofModeAuthorization.IssueForReviewedBoundedProof();
#else
        return null;
#endif
    }

    /// <summary>A stable, body-free refusal. No argument is ever echoed.</summary>
    private static int Refuse(RefusalCode code, int exitCode)
    {
        Write(MutationGate.Describe(new CanonicalObject())
            .Set("code", ProtocolNames.Of(code))
            .Set("component", ComponentIdentity.ComponentName)
            .Set("status", "refused"));
        return exitCode;
    }

    private static void Write(CanonicalObject value)
    {
        using System.IO.Stream output = Console.OpenStandardOutput();
        byte[] bytes = CanonicalJson.Serialize(value);
        output.Write(bytes, 0, bytes.Length);
        output.Write(Utf8.GetBytes("\n"), 0, 1);
        output.Flush();
    }
}

/// <summary>
/// The complete argument surface.
///
/// Three named arguments exist and nothing else is accepted. In particular
/// there is no argument that takes a digest, a security descriptor, a
/// destination path, an owner, a principal, a rights mask, or a "force" switch.
/// ADR 0018 section 2.4 requires that an operator be able to choose WHICH
/// reviewed candidate to install and be unable to introduce a new one; the
/// grammar below is where that is enforced, by having no syntax that could
/// express it.
/// </summary>
internal sealed class Arguments
{
    private Arguments(string runToken, string candidateId, string sourceRoot)
    {
        RunToken = runToken;
        CandidateId = candidateId;
        SourceRoot = sourceRoot;
    }

    internal string RunToken { get; }

    internal string CandidateId { get; }

    /// <summary>
    /// Where to look for the source closure. This is the ONLY caller-influenced
    /// path and it confers no trust: it is parsed into components by the closed
    /// grammar, walked handle-relatively like everything else, and the closure
    /// it leads to must recompute a fingerprint that is a constant of reviewed
    /// source.
    /// </summary>
    internal string SourceRoot { get; }

    internal static Outcome<Arguments> Parse(
        string[] args,
        bool requireSource,
        bool requireCandidate = true)
    {
        string? token = null;
        string? candidate = null;
        string? source = null;

        for (int index = 1; index < args.Length; index += 2)
        {
            if (index + 1 >= args.Length)
            {
                return Outcome<Arguments>.Refused(RefusalCode.ArgumentMissing);
            }

            string name = args[index];
            string value = args[index + 1];
            switch (name)
            {
                case "--token":
                    if (token is not null)
                    {
                        return Outcome<Arguments>.Refused(RefusalCode.ArgumentRepeated);
                    }

                    token = value;
                    break;
                case "--candidate":
                    if (candidate is not null)
                    {
                        return Outcome<Arguments>.Refused(RefusalCode.ArgumentRepeated);
                    }

                    candidate = value;
                    break;
                case "--source":
                    if (source is not null)
                    {
                        return Outcome<Arguments>.Refused(RefusalCode.ArgumentRepeated);
                    }

                    source = value;
                    break;
                default:
                    return Outcome<Arguments>.Refused(RefusalCode.ArgumentInvalid);
            }
        }

        if (token is null || !NameGrammar.IsRunToken(token))
        {
            return Outcome<Arguments>.Refused(RefusalCode.TokenMalformed);
        }

        if (requireCandidate)
        {
            if (candidate is null)
            {
                return Outcome<Arguments>.Refused(RefusalCode.ArgumentMissing);
            }

            // A 64-character hex string is not a candidate identifier, and the
            // identifier grammar is shaped so it can never be mistaken for one.
            if (!NameGrammar.IsCandidateId(candidate))
            {
                return Outcome<Arguments>.Refused(RefusalCode.ArgumentInvalid);
            }
        }
        else if (candidate is not null)
        {
            return Outcome<Arguments>.Refused(RefusalCode.ArgumentInvalid);
        }

        if (requireSource)
        {
            if (source is null)
            {
                return Outcome<Arguments>.Refused(RefusalCode.ArgumentMissing);
            }

            RefusalCode parsed = NameGrammar.TryParseDriveRootedPath(
                source,
                out char _,
                out IReadOnlyList<string> _);
            if (parsed != RefusalCode.None)
            {
                return Outcome<Arguments>.Refused(parsed);
            }
        }
        else if (source is not null)
        {
            return Outcome<Arguments>.Refused(RefusalCode.ArgumentInvalid);
        }

        return Outcome<Arguments>.Success(
            new Arguments(token, candidate ?? string.Empty, source ?? string.Empty));
    }
}

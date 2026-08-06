using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace AiDevOs.WindowsSupervisor;

/// <summary>
/// Supervisor-specific self-test vectors: identity cross-checking, the closed
/// derived recovery plan, and proof that every supervisor-owned mutating
/// operation refuses.
///
/// Like the shared core, this suite runs entirely in memory.
/// </summary>
internal static class RoleConformance
{
    private const string Token = "0123456789abcdef0123456789abcdef";
    private static readonly UTF8Encoding Utf8 = new(encoderShouldEmitUTF8Identifier: false);

    internal static ConformanceReport Run()
    {
        List<ConformanceVector> vectors =
        [
            new ConformanceVector("role/component-name", "windows-supervisor", ComponentIdentity.ComponentName),
            new ConformanceVector("role/role-name", "supervisor", ComponentIdentity.Role),
            new ConformanceVector("role/runtime-identifier", "win-x64", ComponentIdentity.RuntimeIdentifier),
            new ConformanceVector("role/signer-state", "unsigned-candidate", ComponentIdentity.SignerState),
            new ConformanceVector(
                "role/manifest-identity-match",
                "none",
                VerifyIdentity(ManifestFor(ComponentIdentity.ComponentName))),
            new ConformanceVector(
                "role/manifest-identity-other-component",
                "manifest-identity-mismatch",
                VerifyIdentity(ManifestFor("windows-helper"))),
            new ConformanceVector(
                "role/manifest-identity-production-eligible",
                "manifest-identity-mismatch",
                VerifyIdentity(ManifestFor(ComponentIdentity.ComponentName).Replace(
                    "\"productionEligible\":false",
                    "\"productionEligible\":true",
                    StringComparison.Ordinal))),
            new ConformanceVector(
                "role/manifest-identity-claimed-signature",
                "manifest-identity-mismatch",
                VerifyIdentity(ManifestFor(ComponentIdentity.ComponentName).Replace(
                    "\"signerState\":\"unsigned-candidate\"",
                    "\"signerState\":\"authenticode\"",
                    StringComparison.Ordinal))),
            new ConformanceVector(
                "role/manifest-identity-wrong-rid",
                "manifest-identity-mismatch",
                VerifyIdentity(ManifestFor(ComponentIdentity.ComponentName).Replace(
                    "\"rid\":\"win-x64\"",
                    "\"rid\":\"win-arm64\"",
                    StringComparison.Ordinal))),
            new ConformanceVector(
                "role/manifest-identity-wrong-architecture",
                "manifest-identity-mismatch",
                VerifyIdentity(ManifestFor(ComponentIdentity.ComponentName).Replace(
                    "\"architecture\":\"x64\"",
                    "\"architecture\":\"arm64\"",
                    StringComparison.Ordinal))),
            new ConformanceVector(
                "role/manifest-identity-wrong-source-version",
                "manifest-identity-mismatch",
                VerifyIdentity(ManifestFor(ComponentIdentity.ComponentName).Replace(
                    "\"sourceVersion\":\"1.0.0\"",
                    "\"sourceVersion\":\"2.0.0\"",
                    StringComparison.Ordinal))),
            new ConformanceVector(
                "role/manifest-identity-wrong-build-recipe",
                "manifest-identity-mismatch",
                VerifyIdentity(ManifestFor(ComponentIdentity.ComponentName).Replace(
                    "\"buildRecipeVersion\":1",
                    "\"buildRecipeVersion\":2",
                    StringComparison.Ordinal))),
        ];

        AddMutationVectors(vectors);
        AddRecoveryPlanVectors(vectors);
        return new ConformanceReport("windows-supervisor-role-v1", vectors);
    }

    private static void AddMutationVectors(List<ConformanceVector> vectors)
    {
        foreach (SupervisorMutatingOperation operation in Enum.GetValues<SupervisorMutatingOperation>())
        {
            MutatingOperationOutcome outcome = SupervisorOperations.Execute(operation, Token, authorization: null);
            vectors.Add(new ConformanceVector(
                string.Concat("role/mutating-refused/", operation.ToString().ToLowerInvariant()),
                "false:mutating-operations-unauthorized",
                string.Concat(
                    outcome.Performed ? "true:" : "false:",
                    ProtocolNames.Of(outcome.Refusal))));
        }

        // The gate is on the operation path, not merely beside it: an
        // unauthorized caller is refused by MutationGate.Authorize itself.
        vectors.Add(new ConformanceVector(
            "role/mutating-requires-authorization",
            "false:mutating-operations-unauthorized",
            string.Concat(
                SupervisorOperations.Execute(SupervisorMutatingOperation.CreatePrivateJobObject, Token, authorization: null).Performed ? "true:" : "false:",
                ProtocolNames.Of(SupervisorOperations.Execute(SupervisorMutatingOperation.CreatePrivateJobObject, Token, authorization: null).Refusal))));

        MutatingOperationOutcome malformed = SupervisorOperations.Execute(
            SupervisorMutatingOperation.CreatePrivateJobObject,
            "not-a-token",
            authorization: null);
        vectors.Add(new ConformanceVector(
            "role/mutating-refuses-malformed-token-first",
            "false:token-malformed",
            string.Concat(
                malformed.Performed ? "true:" : "false:",
                ProtocolNames.Of(malformed.Refusal))));
    }

    private static void AddRecoveryPlanVectors(List<ConformanceVector> vectors)
    {
        RecoveryJournal partial = JournalWith(OperationState.SetupComplete);
        RecoveryJournal complete = JournalWith(OperationState.CleanupComplete);
        List<string> noLiveTokens = [];
        List<string> liveTokens = [Token];

        RecoveryPlan plan = RecoveryPlan.For(Token, partial, noLiveTokens);
        vectors.Add(new ConformanceVector(
            "role/recovery-plan-closed-derived-set",
            "{\"actionable\":true,\"journalFileName\":\"" + Token + ".journal\"," +
            "\"profileName\":\"" + TokenDerivation.ProfileName(Token) + "\"," +
            "\"stagedFileNames\":[\"" + TokenDerivation.StagedFileNames(Token)[0] + "\",\"" +
            TokenDerivation.StagedFileNames(Token)[1] + "\"]," +
            "\"stagingRootLeaf\":\"" + TokenDerivation.StagingRootLeaf(Token) + "\"}",
            CanonicalJson.SerializeToString(plan.ToCanonical())));
        vectors.Add(new ConformanceVector(
            "role/recovery-plan-skips-completed-operation",
            "false",
            RecoveryPlan.For(Token, complete, noLiveTokens).Actionable ? "true" : "false"));
        vectors.Add(new ConformanceVector(
            "role/recovery-plan-skips-live-operation",
            "false",
            RecoveryPlan.For(Token, partial, liveTokens).Actionable ? "true" : "false"));
        vectors.Add(new ConformanceVector(
            "role/recovery-plan-rejects-malformed-token",
            "false",
            RecoveryPlan.For("nope", partial, noLiveTokens).Actionable ? "true" : "false"));

        IReadOnlyList<MutatingOperationOutcome> outcomes = SupervisorOperations.ExecutePlan(plan, authorization: null);
        vectors.Add(new ConformanceVector(
            "role/recovery-plan-execution-performs-nothing",
            string.Concat("6:false"),
            string.Concat(
                outcomes.Count.ToString(CultureInfo.InvariantCulture),
                ":",
                SupervisorOperations.AnyOperationPerformed(outcomes) ? "true" : "false")));
    }

    private static RecoveryJournal JournalWith(OperationState lastPhase)
    {
        List<byte> buffer = [];
        long sequence = 1;
        foreach (OperationState phase in Phases())
        {
            buffer.AddRange(RecoveryRecordCodec.Frame(
                new RecoveryRecord(ComponentIdentity.ComponentName, Token, phase, sequence, "1.0.0")));
            sequence++;
            if (phase == lastPhase)
            {
                break;
            }
        }

        return RecoveryRecordCodec.TryRead([.. buffer], Token, out RecoveryJournal journal, out _)
            ? journal
            : new RecoveryJournal([], false);
    }

    private static IEnumerable<OperationState> Phases()
    {
        yield return OperationState.RequestAccepted;
        yield return OperationState.SetupComplete;
        yield return OperationState.TargetCreated;
        yield return OperationState.TargetSuspended;
        yield return OperationState.TargetReady;
        yield return OperationState.TargetExited;
        yield return OperationState.CleanupComplete;
    }

    private static string ManifestFor(string component) =>
        CoreConformance.ManifestFixtureJson.Replace(
            "\"component\":\"windows-supervisor\"",
            string.Concat("\"component\":\"", component, "\""),
            StringComparison.Ordinal);

    private static string VerifyIdentity(string manifestJson)
    {
        if (!ArtifactManifestReader.TryParse(
            Utf8.GetBytes(manifestJson),
            out ArtifactManifest manifest,
            out RefusalCode code))
        {
            return string.Concat("parse:", ProtocolNames.Of(code));
        }

        return ProtocolNames.Of(ArtifactManifestVerifier.VerifyIdentity(manifest));
    }
}

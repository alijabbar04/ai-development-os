using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace AiDevOs.WindowsSandboxFeasibilityProbe;

internal static class Program
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        WriteIndented = false,
    };

    internal static int Main(string[] args)
    {
        try
        {
            if (args.Length == 1 && args[0] == "self-test")
            {
                bool passed =
                    AppContainerSyntheticProcessProof.RunLifecycleProtocolSelfTest() &&
                    AppContainerSyntheticProcessProof.RunStage17WReadOnlySelfTest();
                Write(new
                {
                    schemaVersion = 1,
                    component = "windows-proof-controller",
                    status = passed ? "passed" : "failed",
                    suite = "windows-proof-controller-v1",
                    vectorCount = 2,
                    failedVectorCount = passed ? 0 : 1,
                    conformanceDigest = AppContainerSyntheticProcessProof.Stage17WReadOnlyDigest(),
                    buildFlavor = MutationGate.BuildFlavor,
                    proofModeCompiledIn = MutationGate.ProofModeCompiledIn,
                    hostStateCreated = false,
                    nativeFileSystemInstantiated = false,
                    nativeOpenAttempts = 0,
                    installableCandidateCount = 0,
                });
                return passed ? 0 : 1;
            }

            if (args.Length == 1 && args[0] == "describe-artifact")
            {
                Write(new
                {
                    schemaVersion = 1,
                    component = "windows-proof-controller",
                    role = "proof-only-controller",
                    productionEligible = false,
                    buildFlavor = MutationGate.BuildFlavor,
                    proofModeCompiledIn = MutationGate.ProofModeCompiledIn,
                    status = "described",
                });
                return 0;
            }

            if (args.Length == 3 && args[1] == "--token" && args[0] == "plan")
            {
                Stage17WPlan plan = AppContainerSyntheticProcessProof.CreateStage17WPlan(args[2]);
                Write(plan);
                return plan.Status == "planned" ? 0 : 2;
            }

            if (args.Length == 3 && args[1] == "--token" && args[0] == "run")
            {
                ReviewedProofAuthorization? authorization = Authorization();
                if (!MutationGate.Authorized(authorization))
                {
                    WriteStableRefusal("proof-mode-not-authorized");
                    return 2;
                }

                Stage17WProofResult result =
                    AppContainerSyntheticProcessProof.RunStage17W(args[2], authorization!);
                Write(result);
                return result.Status == "passed" ? 0 : 3;
            }

            if (args.Length == 3 && args[1] == "--token" && args[0] == "egress")
            {
                ReviewedProofAuthorization? authorization = Authorization();
                if (!MutationGate.Authorized(authorization))
                {
                    WriteStableRefusal("proof-mode-not-authorized");
                    return 2;
                }

                Stage17WEgressResult result =
                    AppContainerSyntheticProcessProof.RunStage17WEgress(args[2], authorization!);
                Write(result);
                return result.Status == "passed" ? 0 : 3;
            }

            WriteStableRefusal("unknown-command");
            return 64;
        }
        catch (Exception exception) when (!IsFatal(exception))
        {
            WriteStableRefusal("controller-command-failed");
            return 70;
        }
    }

    private static ReviewedProofAuthorization? Authorization()
    {
#if AIDEVOS_STAGE17_REVIEWED_PROOF_MODE
        return ReviewedProofAuthorization.IssueAtReviewedCompileSite();
#else
        return null;
#endif
    }

    private static void WriteStableRefusal(string code) =>
        Write(new Dictionary<string, object?>
        {
            ["schemaVersion"] = 1,
            ["component"] = "windows-proof-controller",
            ["status"] = "refused",
            ["code"] = code,
            ["buildFlavor"] = MutationGate.BuildFlavor,
            ["proofModeCompiledIn"] = MutationGate.ProofModeCompiledIn,
        });

    private static void Write<T>(T value) =>
        Console.Out.WriteLine(JsonSerializer.Serialize(value, JsonOptions));

    private static bool IsFatal(Exception exception) =>
        exception is OutOfMemoryException or StackOverflowException or AccessViolationException;
}

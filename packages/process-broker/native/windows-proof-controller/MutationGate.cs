using System;

namespace AiDevOs.WindowsSandboxFeasibilityProbe;

internal sealed class ReviewedProofAuthorization
{
    private ReviewedProofAuthorization()
    {
    }

#if AIDEVOS_STAGE17_REVIEWED_PROOF_MODE
    internal static ReviewedProofAuthorization IssueAtReviewedCompileSite() => new();
#endif
}

internal static class MutationGate
{
#if AIDEVOS_STAGE17_REVIEWED_PROOF_MODE
    internal const bool ProofModeCompiledIn = true;
    internal const string BuildFlavor = "reviewed-proof-mode";
#else
    internal const bool ProofModeCompiledIn = false;
    internal const string BuildFlavor = "sealed";
#endif

    internal static bool Authorized(ReviewedProofAuthorization? authorization) =>
        ProofModeCompiledIn && authorization is not null;
}

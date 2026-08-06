using System;
using System.Collections.Generic;

namespace AiDevOs.WindowsHelper;

/// <summary>
/// The mutating operations the helper owns in the ADR 0017 design (section 1.3
/// and the section 1.6 ownership table). They exist here as a closed
/// enumeration so the protocol, the state machine, and the staging plan can be
/// written and tested against the real shape of the design. None of them is
/// implemented in this checkpoint.
///
/// Note what is absent by design: there is no "restore a security descriptor"
/// operation. The helper never modifies the security descriptor of a
/// pre-existing object; it creates fresh, uniquely named directories and sets
/// their DACL at creation time, so cleanup reduces to deleting what it made.
/// </summary>
internal enum HelperMutatingOperation
{
    CreateAppContainerProfile = 1,
    DeriveAppContainerSid,
    CreateTaskOwnedStagingDirectory,
    ApplyStagingDirectoryDacl,
    StageToolClosureFile,
    BuildProcessAttributeList,
    CreateTargetProcessSuspended,
    ResumeTargetThread,
    CloseTargetHandles,
    RemoveStagedFile,
    RemoveStagingDirectory,
    DeleteAppContainerProfile,
}

/// <summary>The result of offering a mutating operation to the gate.</summary>
internal sealed class MutatingOperationOutcome
{
    internal MutatingOperationOutcome(
        HelperMutatingOperation operation,
        bool performed,
        RefusalCode refusal)
    {
        Operation = operation;
        Performed = performed;
        Refusal = refusal;
    }

    internal HelperMutatingOperation Operation { get; }

    internal bool Performed { get; }

    internal RefusalCode Refusal { get; }
}

/// <summary>
/// The exact set of names one operation is allowed to create, derived purely
/// from its token. Building a plan is a pure function: no directory is read, no
/// name is guessed, and no path is accepted from a caller or a journal.
/// </summary>
internal sealed class StagingPlan
{
    private StagingPlan(
        string operationToken,
        bool valid,
        string profileName,
        string stagingRootLeaf,
        IReadOnlyList<string> stagedFileNames)
    {
        OperationToken = operationToken;
        Valid = valid;
        ProfileName = profileName;
        StagingRootLeaf = stagingRootLeaf;
        StagedFileNames = stagedFileNames;
    }

    internal string OperationToken { get; }

    internal bool Valid { get; }

    internal string ProfileName { get; }

    internal string StagingRootLeaf { get; }

    internal IReadOnlyList<string> StagedFileNames { get; }

    internal static StagingPlan For(string operationToken)
    {
        if (!TokenDerivation.IsValidOperationToken(operationToken))
        {
            return new StagingPlan(operationToken, false, string.Empty, string.Empty, []);
        }

        return new StagingPlan(
            operationToken,
            true,
            TokenDerivation.ProfileName(operationToken),
            TokenDerivation.StagingRootLeaf(operationToken),
            TokenDerivation.StagedFileNames(operationToken));
    }

    internal CanonicalObject ToCanonical() =>
        new CanonicalObject()
            .Set("profileName", ProfileName)
            .Set("stagedFileNames", StagedFileNames)
            .Set("stagingRootLeaf", StagingRootLeaf)
            .Set("valid", Valid);
}

/// <summary>
/// The gated dispatcher for helper-owned mutating operations.
///
/// Every call refuses. The mutating branch below is structurally unreachable
/// because <see cref="MutationGate.MutatingOperationsPermitted"/> is a
/// compile-time <see langword="false"/> constant with no run-time path to it,
/// and no native implementation exists behind it either.
/// </summary>
internal static class HelperOperations
{
    internal static MutatingOperationOutcome Execute(
        HelperMutatingOperation operation,
        string operationToken)
    {
        if (!TokenDerivation.IsValidOperationToken(operationToken))
        {
            return new MutatingOperationOutcome(operation, false, RefusalCode.TokenMalformed);
        }

        if (MutationGate.MutatingOperationsPermitted)
        {
            // Structural gate. Unreachable in this checkpoint: the gate is a
            // compile-time false constant and nothing configurable maps to it.
            // A reviewed native implementation would be introduced here only
            // after a separately authorized bounded stateful proof; until then
            // the branch refuses rather than silently succeeding.
            return new MutatingOperationOutcome(operation, false, RefusalCode.InternalRefusal);
        }

        return new MutatingOperationOutcome(
            operation,
            false,
            RefusalCode.MutatingOperationsStructurallyDisabled);
    }

    /// <summary>
    /// Executes a whole staging plan. Also fully gated: a plan describes what
    /// would be created, and describing is not doing.
    /// </summary>
    internal static IReadOnlyList<MutatingOperationOutcome> ExecutePlan(StagingPlan plan)
    {
        List<MutatingOperationOutcome> outcomes = [];
        if (!plan.Valid)
        {
            return outcomes;
        }

        foreach (HelperMutatingOperation step in Enum.GetValues<HelperMutatingOperation>())
        {
            outcomes.Add(Execute(step, plan.OperationToken));
        }

        return outcomes;
    }

    internal static bool AnyOperationPerformed(IReadOnlyList<MutatingOperationOutcome> outcomes)
    {
        foreach (MutatingOperationOutcome outcome in outcomes)
        {
            if (outcome.Performed)
            {
                return true;
            }
        }

        return false;
    }
}

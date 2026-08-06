using System;
using System.Collections.Generic;

namespace AiDevOs.WindowsSupervisor;

/// <summary>
/// The mutating operations the supervisor owns in the ADR 0017 design
/// (section 1.2 and the section 1.6 ownership table). They exist here as a
/// closed enumeration so the protocol, the state machine, and the recovery
/// planner can be written and tested against the real shape of the design.
/// None of them is implemented in this checkpoint.
/// </summary>
internal enum SupervisorMutatingOperation
{
    CreatePrivateJobObject = 1,
    LaunchHelperProcess,
    WriteRecoveryRecord,
    TerminateJobObject,
    DrainJobToZeroActiveProcesses,
    DeleteAppContainerProfile,
    RemoveStagedFile,
    RemoveStagingDirectory,
    RemoveRecoveryJournalFile,
}

/// <summary>The result of offering a mutating operation to the gate.</summary>
internal sealed class MutatingOperationOutcome
{
    internal MutatingOperationOutcome(
        SupervisorMutatingOperation operation,
        bool performed,
        RefusalCode refusal)
    {
        Operation = operation;
        Performed = performed;
        Refusal = refusal;
    }

    internal SupervisorMutatingOperation Operation { get; }

    internal bool Performed { get; }

    internal RefusalCode Refusal { get; }
}

/// <summary>
/// One exact, non-recursive cleanup plan derived purely from an operation
/// token (ADR 0017 sections 2.7 and 5). Building a plan is a pure function:
/// it never enumerates processes, never reads a directory, never guesses a
/// name, and never accepts a path from a journal or a caller.
/// </summary>
internal sealed class RecoveryPlan
{
    private RecoveryPlan(
        string operationToken,
        bool actionable,
        string profileName,
        string stagingRootLeaf,
        string journalFileName,
        IReadOnlyList<string> stagedFileNames)
    {
        OperationToken = operationToken;
        Actionable = actionable;
        ProfileName = profileName;
        StagingRootLeaf = stagingRootLeaf;
        JournalFileName = journalFileName;
        StagedFileNames = stagedFileNames;
    }

    internal string OperationToken { get; }

    internal bool Actionable { get; }

    internal string ProfileName { get; }

    internal string StagingRootLeaf { get; }

    internal string JournalFileName { get; }

    internal IReadOnlyList<string> StagedFileNames { get; }

    internal static RecoveryPlan None(string operationToken) =>
        new(operationToken, false, string.Empty, string.Empty, string.Empty, []);

    internal static RecoveryPlan For(
        string operationToken,
        RecoveryJournal journal,
        IReadOnlyCollection<string> liveTokens)
    {
        if (!TokenDerivation.IsValidOperationToken(operationToken) ||
            !RecoveryRecordCodec.IsActionable(operationToken, journal, liveTokens))
        {
            return None(operationToken);
        }

        return new RecoveryPlan(
            operationToken,
            true,
            TokenDerivation.ProfileName(operationToken),
            TokenDerivation.StagingRootLeaf(operationToken),
            TokenDerivation.JournalFileName(operationToken),
            TokenDerivation.StagedFileNames(operationToken));
    }

    internal CanonicalObject ToCanonical() =>
        new CanonicalObject()
            .Set("actionable", Actionable)
            .Set("journalFileName", JournalFileName)
            .Set("profileName", ProfileName)
            .Set("stagedFileNames", StagedFileNames)
            .Set("stagingRootLeaf", StagingRootLeaf);
}

/// <summary>
/// The gated dispatcher for supervisor-owned mutating operations.
///
/// Every call refuses. The mutating branch below is structurally unreachable
/// because <see cref="MutationGate.MutatingOperationsPermitted"/> is a
/// compile-time <see langword="false"/> constant with no run-time path to it,
/// and no native implementation exists behind it either.
/// </summary>
internal static class SupervisorOperations
{
    internal static MutatingOperationOutcome Execute(
        SupervisorMutatingOperation operation,
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
    /// Executes a whole recovery plan. Also fully gated: a plan describes what
    /// would be removed, and describing is not doing.
    /// </summary>
    internal static IReadOnlyList<MutatingOperationOutcome> ExecutePlan(RecoveryPlan plan)
    {
        List<MutatingOperationOutcome> outcomes = [];
        if (!plan.Actionable)
        {
            return outcomes;
        }

        SupervisorMutatingOperation[] steps =
        [
            SupervisorMutatingOperation.TerminateJobObject,
            SupervisorMutatingOperation.DrainJobToZeroActiveProcesses,
            SupervisorMutatingOperation.RemoveStagedFile,
            SupervisorMutatingOperation.RemoveStagingDirectory,
            SupervisorMutatingOperation.DeleteAppContainerProfile,
            SupervisorMutatingOperation.RemoveRecoveryJournalFile,
        ];

        foreach (SupervisorMutatingOperation step in steps)
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

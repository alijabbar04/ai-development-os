using System;

namespace AiDevOs.WindowsSupervisor;

/// <summary>The outcome of offering one parsed message to the state machine.</summary>
internal enum TransitionOutcome
{
    Accepted = 0,
    Completed,
    Cancelled,
    Refused,
}

/// <summary>Result of a single transition attempt.</summary>
internal readonly struct TransitionResult : IEquatable<TransitionResult>
{
    internal TransitionResult(TransitionOutcome outcome, OperationState state, RefusalCode refusal)
    {
        Outcome = outcome;
        State = state;
        Refusal = refusal;
    }

    internal TransitionOutcome Outcome { get; }

    internal OperationState State { get; }

    internal RefusalCode Refusal { get; }

    public bool Equals(TransitionResult other) =>
        Outcome == other.Outcome && State == other.State && Refusal == other.Refusal;

    public override bool Equals(object? obj) => obj is TransitionResult other && Equals(other);

    public override int GetHashCode() => HashCode.Combine(Outcome, State, Refusal);

    public static bool operator ==(TransitionResult left, TransitionResult right) =>
        left.Equals(right);

    public static bool operator !=(TransitionResult left, TransitionResult right) =>
        !left.Equals(right);
}

/// <summary>
/// The linear, monotonic operation state machine of ADR 0017 section 4.3, with
/// the token binding of section 4.4.
///
/// The machine is deliberately total: every input either advances exactly one
/// step or terminates the connection with a body-free refusal. There is no
/// "ignore and continue" path, no reset, and no way to revisit a state.
/// </summary>
internal sealed class OperationStateMachine
{
    private string? boundToken;
    private long lastSequence;
    private bool terminated;

    internal OperationState State { get; private set; } = OperationState.None;

    internal string? BoundToken => boundToken;

    internal bool Terminated => terminated;

    internal static OperationState NextState(OperationState state) => state switch
    {
        OperationState.None => OperationState.RequestAccepted,
        OperationState.RequestAccepted => OperationState.SetupComplete,
        OperationState.SetupComplete => OperationState.TargetCreated,
        OperationState.TargetCreated => OperationState.TargetSuspended,
        OperationState.TargetSuspended => OperationState.TargetReady,
        OperationState.TargetReady => OperationState.TargetExited,
        OperationState.TargetExited => OperationState.CleanupComplete,
        _ => OperationState.CleanupComplete,
    };

    internal TransitionResult Offer(ProtocolMessage message)
    {
        if (message is null)
        {
            return Terminate(RefusalCode.InternalRefusal);
        }

        if (terminated)
        {
            return Terminate(RefusalCode.StateOutOfOrder);
        }

        if (message.Type == ProtocolMessageType.SetupRequest)
        {
            if (State != OperationState.None)
            {
                return Terminate(RefusalCode.SetupDuplicate);
            }

            boundToken = message.OperationToken;
            State = OperationState.RequestAccepted;
            return new TransitionResult(TransitionOutcome.Accepted, State, RefusalCode.None);
        }

        if (State == OperationState.None)
        {
            return Terminate(RefusalCode.SetupMissing);
        }

        if (!string.Equals(boundToken, message.OperationToken, StringComparison.Ordinal))
        {
            return Terminate(RefusalCode.TokenMismatch);
        }

        switch (message.Type)
        {
            case ProtocolMessageType.Cancel:
                terminated = true;
                return new TransitionResult(
                    TransitionOutcome.Cancelled,
                    State,
                    RefusalCode.OperationCancelled);
            case ProtocolMessageType.Refusal:
                return Terminate(
                    message.Refusal == RefusalCode.None
                        ? RefusalCode.InternalRefusal
                        : message.Refusal);
            case ProtocolMessageType.StateReport:
                return OfferStateReport(message);
            default:
                return Terminate(RefusalCode.UnknownMessageType);
        }
    }

    private TransitionResult OfferStateReport(ProtocolMessage message)
    {
        if (message.Sequence <= lastSequence)
        {
            return Terminate(RefusalCode.StateOutOfOrder);
        }

        if (message.State == State)
        {
            return Terminate(RefusalCode.StateDuplicate);
        }

        if (message.State != NextState(State))
        {
            return Terminate(RefusalCode.StateOutOfOrder);
        }

        lastSequence = message.Sequence;
        State = message.State;
        if (State == OperationState.CleanupComplete)
        {
            terminated = true;
            return new TransitionResult(TransitionOutcome.Completed, State, RefusalCode.None);
        }

        return new TransitionResult(TransitionOutcome.Accepted, State, RefusalCode.None);
    }

    private TransitionResult Terminate(RefusalCode refusal)
    {
        terminated = true;
        return new TransitionResult(TransitionOutcome.Refused, State, refusal);
    }
}

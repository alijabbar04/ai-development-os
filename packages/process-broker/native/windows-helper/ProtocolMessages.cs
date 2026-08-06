using System;
using System.Collections.Generic;

namespace AiDevOs.WindowsHelper;

/// <summary>
/// The exact binding fingerprints a setup request carries (ADR 0017
/// section 4.4). Every value is a 64-character lowercase hexadecimal digest
/// except <see cref="EndpointPolicy"/>, which is explicitly null when no
/// control-plane endpoint policy applies.
/// </summary>
internal sealed class SetupBindings
{
    internal SetupBindings(
        string request,
        string grant,
        string policy,
        string lease,
        string workspace,
        string tool,
        string? endpointPolicy,
        string quotas)
    {
        Request = request;
        Grant = grant;
        Policy = policy;
        Lease = lease;
        Workspace = workspace;
        Tool = tool;
        EndpointPolicy = endpointPolicy;
        Quotas = quotas;
    }

    internal string Request { get; }

    internal string Grant { get; }

    internal string Policy { get; }

    internal string Lease { get; }

    internal string Workspace { get; }

    internal string Tool { get; }

    internal string? EndpointPolicy { get; }

    internal string Quotas { get; }
}

/// <summary>Supervisor, helper, and build identity digests.</summary>
internal sealed class SetupIdentities
{
    internal SetupIdentities(string supervisor, string helper, string build)
    {
        Supervisor = supervisor;
        Helper = helper;
        Build = build;
    }

    internal string Supervisor { get; }

    internal string Helper { get; }

    internal string Build { get; }
}

/// <summary>One parsed, fully validated protocol message.</summary>
internal sealed class ProtocolMessage
{
    private ProtocolMessage(
        ProtocolMessageType type,
        string operationToken,
        SetupBindings? bindings,
        SetupIdentities? identities,
        string? bundleVersion,
        OperationState state,
        long sequence,
        RefusalCode refusal)
    {
        Type = type;
        OperationToken = operationToken;
        Bindings = bindings;
        Identities = identities;
        BundleVersion = bundleVersion;
        State = state;
        Sequence = sequence;
        Refusal = refusal;
    }

    internal ProtocolMessageType Type { get; }

    internal string OperationToken { get; }

    internal SetupBindings? Bindings { get; }

    internal SetupIdentities? Identities { get; }

    internal string? BundleVersion { get; }

    internal OperationState State { get; }

    internal long Sequence { get; }

    internal RefusalCode Refusal { get; }

    private static readonly string[] BindingNames =
    [
        "request",
        "grant",
        "policy",
        "lease",
        "workspace",
        "tool",
        "endpointPolicy",
        "quotas",
    ];

    /// <summary>
    /// Parses one frame payload. Returns <see langword="false"/> with a
    /// body-free refusal code for every malformed, unknown, over-long,
    /// duplicate-property, prototype-polluting, or out-of-range input.
    /// </summary>
    internal static bool TryParse(
        ReadOnlySpan<byte> payload,
        out ProtocolMessage message,
        out RefusalCode code)
    {
        message = Empty;
        if (!StrictJson.TryParseObject(payload, out StrictObject root, out code))
        {
            return false;
        }

        if (!root.TryTake("protocolVersion", StrictKind.Integer, out StrictValue protocolVersion, out code))
        {
            return false;
        }

        if (protocolVersion.Integer != ProtocolContract.ProtocolVersion)
        {
            code = RefusalCode.ProtocolVersionMismatch;
            return false;
        }

        if (!root.TryTake("schemaVersion", StrictKind.Integer, out StrictValue schemaVersion, out code))
        {
            return false;
        }

        if (schemaVersion.Integer != ProtocolContract.SchemaVersion)
        {
            code = RefusalCode.SchemaVersionMismatch;
            return false;
        }

        if (!root.TryTake("type", StrictKind.String, out StrictValue typeValue, out code))
        {
            return false;
        }

        if (!ProtocolNames.TryParseMessageType(typeValue.Text ?? string.Empty, out ProtocolMessageType type))
        {
            code = RefusalCode.UnknownMessageType;
            return false;
        }

        if (!root.TryTake("operationToken", StrictKind.String, out StrictValue tokenValue, out code))
        {
            return false;
        }

        string token = tokenValue.Text ?? string.Empty;
        if (!StrictJson.IsLowercaseHex(token, ProtocolContract.OperationTokenHexLength))
        {
            code = RefusalCode.TokenMalformed;
            return false;
        }

        switch (type)
        {
            case ProtocolMessageType.SetupRequest:
                return TryParseSetup(root, token, out message, out code);
            case ProtocolMessageType.StateReport:
                return TryParseStateReport(root, token, out message, out code);
            case ProtocolMessageType.Cancel:
                if (!root.RequireExhausted(out code))
                {
                    return false;
                }

                message = new ProtocolMessage(
                    ProtocolMessageType.Cancel,
                    token,
                    null,
                    null,
                    null,
                    OperationState.None,
                    0,
                    RefusalCode.None);
                return true;
            case ProtocolMessageType.Refusal:
                return TryParseRefusal(root, token, out message, out code);
            default:
                code = RefusalCode.UnknownMessageType;
                return false;
        }
    }

    private static bool TryParseSetup(
        StrictObject root,
        string token,
        out ProtocolMessage message,
        out RefusalCode code)
    {
        message = Empty;

        if (!root.TryTake("bindings", StrictKind.Object, out StrictValue bindingsValue, out code))
        {
            return false;
        }

        StrictObject bindings = bindingsValue.Child ?? new StrictObject();
        Dictionary<string, string?> bound = new(StringComparer.Ordinal);
        foreach (string name in BindingNames)
        {
            bool nullable = string.Equals(name, "endpointPolicy", StringComparison.Ordinal);
            bool taken = nullable
                ? bindings.TryTakeNullable(name, StrictKind.String, out StrictValue value, out code)
                : bindings.TryTake(name, StrictKind.String, out value, out code);
            if (!taken)
            {
                return false;
            }

            if (value.Kind == StrictKind.Null)
            {
                bound[name] = null;
                continue;
            }

            if (!StrictJson.IsLowercaseHex(value.Text, ProtocolContract.FingerprintHexLength))
            {
                code = RefusalCode.ValueOutOfRange;
                return false;
            }

            bound[name] = value.Text;
        }

        if (!bindings.RequireExhausted(out code))
        {
            return false;
        }

        if (!root.TryTake("identities", StrictKind.Object, out StrictValue identitiesValue, out code))
        {
            return false;
        }

        StrictObject identities = identitiesValue.Child ?? new StrictObject();
        string[] identityNames = ["supervisor", "helper", "build"];
        Dictionary<string, string> identityValues = new(StringComparer.Ordinal);
        foreach (string name in identityNames)
        {
            if (!identities.TryTake(name, StrictKind.String, out StrictValue value, out code))
            {
                return false;
            }

            if (!StrictJson.IsLowercaseHex(value.Text, ProtocolContract.FingerprintHexLength))
            {
                code = RefusalCode.ValueOutOfRange;
                return false;
            }

            identityValues[name] = value.Text ?? string.Empty;
        }

        if (!identities.RequireExhausted(out code))
        {
            return false;
        }

        if (!root.TryTake("bundleVersion", StrictKind.String, out StrictValue bundleVersion, out code))
        {
            return false;
        }

        if (!IsAcceptableBundleVersion(bundleVersion.Text))
        {
            code = RefusalCode.ValueOutOfRange;
            return false;
        }

        if (!root.RequireExhausted(out code))
        {
            return false;
        }

        message = new ProtocolMessage(
            ProtocolMessageType.SetupRequest,
            token,
            new SetupBindings(
                bound["request"] ?? string.Empty,
                bound["grant"] ?? string.Empty,
                bound["policy"] ?? string.Empty,
                bound["lease"] ?? string.Empty,
                bound["workspace"] ?? string.Empty,
                bound["tool"] ?? string.Empty,
                bound["endpointPolicy"],
                bound["quotas"] ?? string.Empty),
            new SetupIdentities(
                identityValues["supervisor"],
                identityValues["helper"],
                identityValues["build"]),
            bundleVersion.Text,
            OperationState.RequestAccepted,
            0,
            RefusalCode.None);
        code = RefusalCode.None;
        return true;
    }

    private static bool TryParseStateReport(
        StrictObject root,
        string token,
        out ProtocolMessage message,
        out RefusalCode code)
    {
        message = Empty;
        if (!root.TryTake("state", StrictKind.String, out StrictValue stateValue, out code))
        {
            return false;
        }

        if (!ProtocolNames.TryParseState(stateValue.Text ?? string.Empty, out OperationState state))
        {
            code = RefusalCode.StateUnknown;
            return false;
        }

        if (!root.TryTake("sequence", StrictKind.Integer, out StrictValue sequence, out code))
        {
            return false;
        }

        if (sequence.Integer < ProtocolContract.MinSequence ||
            sequence.Integer > ProtocolContract.MaxSequence)
        {
            code = RefusalCode.ValueOutOfRange;
            return false;
        }

        if (!root.RequireExhausted(out code))
        {
            return false;
        }

        message = new ProtocolMessage(
            ProtocolMessageType.StateReport,
            token,
            null,
            null,
            null,
            state,
            sequence.Integer,
            RefusalCode.None);
        return true;
    }

    private static bool TryParseRefusal(
        StrictObject root,
        string token,
        out ProtocolMessage message,
        out RefusalCode code)
    {
        message = Empty;
        if (!root.TryTake("code", StrictKind.String, out StrictValue codeValue, out code))
        {
            return false;
        }

        RefusalCode parsed = RefusalCode.InternalRefusal;
        bool known = false;
        foreach (RefusalCode candidate in Enum.GetValues<RefusalCode>())
        {
            if (string.Equals(ProtocolNames.Of(candidate), codeValue.Text, StringComparison.Ordinal))
            {
                parsed = candidate;
                known = true;
                break;
            }
        }

        if (!known)
        {
            code = RefusalCode.ValueOutOfRange;
            return false;
        }

        if (!root.RequireExhausted(out code))
        {
            return false;
        }

        message = new ProtocolMessage(
            ProtocolMessageType.Refusal,
            token,
            null,
            null,
            null,
            OperationState.None,
            0,
            parsed);
        return true;
    }

    /// <summary>
    /// Serializes a body-free refusal. The payload carries the closed-enum code
    /// and the operation token and nothing else: no message, no path, no
    /// offending value, and no exception detail.
    /// </summary>
    internal static byte[] SerializeRefusal(string operationToken, RefusalCode refusal)
    {
        CanonicalObject payload = new CanonicalObject()
            .Set("code", ProtocolNames.Of(refusal))
            .Set("operationToken", operationToken)
            .Set("protocolVersion", ProtocolContract.ProtocolVersion)
            .Set("schemaVersion", ProtocolContract.SchemaVersion)
            .Set("type", ProtocolNames.Of(ProtocolMessageType.Refusal));
        return CanonicalJson.Serialize(payload);
    }

    internal static bool IsAcceptableBundleVersion(string? value)
    {
        if (value is null ||
            value.Length == 0 ||
            value.Length > ProtocolContract.MaxBundleVersionLength)
        {
            return false;
        }

        int segment = 0;
        int digitsInSegment = 0;
        int index = 0;
        for (; index < value.Length; index++)
        {
            char character = value[index];
            if (char.IsAsciiDigit(character))
            {
                digitsInSegment++;
                if (digitsInSegment > 4)
                {
                    return false;
                }

                continue;
            }

            if (character == '.' && segment < 2)
            {
                if (digitsInSegment == 0)
                {
                    return false;
                }

                segment++;
                digitsInSegment = 0;
                continue;
            }

            break;
        }

        if (segment != 2 || digitsInSegment == 0)
        {
            return false;
        }

        if (index == value.Length)
        {
            return true;
        }

        if (value[index] != '-')
        {
            return false;
        }

        index++;
        int labelLength = 0;
        for (; index < value.Length; index++)
        {
            char character = value[index];
            if (char.IsAsciiDigit(character) || char.IsAsciiLetterLower(character))
            {
                labelLength++;
                if (labelLength > 16)
                {
                    return false;
                }

                continue;
            }

            if (character == '.' && labelLength > 0)
            {
                labelLength = 0;
                continue;
            }

            return false;
        }

        return labelLength > 0;
    }

    private static ProtocolMessage Empty { get; } = new(
        ProtocolMessageType.Refusal,
        new string('0', ProtocolContract.OperationTokenHexLength),
        null,
        null,
        null,
        OperationState.None,
        0,
        RefusalCode.InternalRefusal);
}

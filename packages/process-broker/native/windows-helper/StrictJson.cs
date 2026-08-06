using System;
using System.Collections.Generic;
using System.Text;
using System.Text.Json;

namespace AiDevOs.WindowsHelper;

/// <summary>The closed set of value shapes the strict parser accepts.</summary>
internal enum StrictKind
{
    Null = 0,
    Boolean,
    Integer,
    String,
    StringArray,
    ObjectArray,
    Object,
}

/// <summary>
/// Parsing bounds. Protocol frames and artifact manifests use different
/// presets, but both are fixed constants: no input can widen its own limits.
/// </summary>
internal sealed class StrictLimits
{
    private StrictLimits(
        int maxDepth,
        int maxObjectMembers,
        int maxStringLength,
        int maxArrayLength,
        bool allowObjectArrays)
    {
        MaxDepth = maxDepth;
        MaxObjectMembers = maxObjectMembers;
        MaxStringLength = maxStringLength;
        MaxArrayLength = maxArrayLength;
        AllowObjectArrays = allowObjectArrays;
    }

    internal int MaxDepth { get; }

    internal int MaxObjectMembers { get; }

    internal int MaxStringLength { get; }

    internal int MaxArrayLength { get; }

    internal bool AllowObjectArrays { get; }

    /// <summary>Bounds for protocol frames (ADR 0017 section 4.2).</summary>
    internal static StrictLimits Protocol { get; } = new(
        ProtocolContract.MaxJsonDepth,
        ProtocolContract.MaxObjectMembers,
        ProtocolContract.MaxStringLength,
        ProtocolContract.MaxStringArrayLength,
        allowObjectArrays: false);

    /// <summary>Bounds for the artifact manifest (ADR 0017 section 6.3).</summary>
    internal static StrictLimits Manifest { get; } = new(
        ProtocolContract.MaxJsonDepth,
        ProtocolContract.MaxManifestObjectMembers,
        ProtocolContract.MaxStringLength,
        ProtocolContract.MaxManifestFileCount,
        allowObjectArrays: true);
}

/// <summary>An immutable parsed value in one of the accepted shapes.</summary>
internal sealed class StrictValue
{
    private StrictValue(
        StrictKind kind,
        bool boolean,
        long integer,
        string? text,
        IReadOnlyList<string>? strings,
        IReadOnlyList<StrictObject>? objects,
        StrictObject? child)
    {
        Kind = kind;
        Boolean = boolean;
        Integer = integer;
        Text = text;
        Strings = strings;
        Objects = objects;
        Child = child;
    }

    internal StrictKind Kind { get; }

    internal bool Boolean { get; }

    internal long Integer { get; }

    internal string? Text { get; }

    internal IReadOnlyList<string>? Strings { get; }

    internal IReadOnlyList<StrictObject>? Objects { get; }

    internal StrictObject? Child { get; }

    internal static StrictValue Null { get; } =
        new(StrictKind.Null, false, 0, null, null, null, null);

    internal static StrictValue Of(bool value) =>
        new(StrictKind.Boolean, value, 0, null, null, null, null);

    internal static StrictValue Of(long value) =>
        new(StrictKind.Integer, false, value, null, null, null, null);

    internal static StrictValue Of(string value) =>
        new(StrictKind.String, false, 0, value, null, null, null);

    internal static StrictValue Of(IReadOnlyList<string> values) =>
        new(StrictKind.StringArray, false, 0, null, values, null, null);

    internal static StrictValue Of(IReadOnlyList<StrictObject> values) =>
        new(StrictKind.ObjectArray, false, 0, null, null, values, null);

    internal static StrictValue Of(StrictObject value) =>
        new(StrictKind.Object, false, 0, null, null, null, value);
}

/// <summary>
/// A parsed object plus the exact-property discipline of ADR 0017 section 4.2.
/// A caller takes every property it expects and then calls
/// <see cref="RequireExhausted"/>; anything left over is an unknown property
/// and therefore a refusal.
/// </summary>
internal sealed class StrictObject
{
    private readonly Dictionary<string, StrictValue> members = new(StringComparer.Ordinal);
    private readonly HashSet<string> taken = new(StringComparer.Ordinal);

    internal int Count => members.Count;

    internal bool TryAdd(string name, StrictValue value)
    {
        if (members.ContainsKey(name))
        {
            return false;
        }

        members.Add(name, value);
        return true;
    }

    internal bool TryTake(string name, StrictKind kind, out StrictValue value, out RefusalCode code)
    {
        if (!members.TryGetValue(name, out StrictValue? found))
        {
            value = StrictValue.Null;
            code = RefusalCode.MissingProperty;
            return false;
        }

        taken.Add(name);
        if (found.Kind != kind)
        {
            value = StrictValue.Null;
            code = RefusalCode.TypeMismatch;
            return false;
        }

        value = found;
        code = RefusalCode.None;
        return true;
    }

    /// <summary>Takes a property that is allowed to be explicitly null.</summary>
    internal bool TryTakeNullable(
        string name,
        StrictKind kind,
        out StrictValue value,
        out RefusalCode code)
    {
        if (!members.TryGetValue(name, out StrictValue? found))
        {
            value = StrictValue.Null;
            code = RefusalCode.MissingProperty;
            return false;
        }

        taken.Add(name);
        if (found.Kind != kind && found.Kind != StrictKind.Null)
        {
            value = StrictValue.Null;
            code = RefusalCode.TypeMismatch;
            return false;
        }

        value = found;
        code = RefusalCode.None;
        return true;
    }

    internal bool RequireExhausted(out RefusalCode code)
    {
        foreach (string name in members.Keys)
        {
            if (!taken.Contains(name))
            {
                code = RefusalCode.UnknownProperty;
                return false;
            }
        }

        code = RefusalCode.None;
        return true;
    }
}

/// <summary>
/// Strict UTF-8 JSON parsing for protocol frames, recovery records, and
/// artifact manifests.
///
/// Rejected outright: invalid UTF-8, a byte-order mark, comments, trailing
/// commas, trailing content after the top-level value, non-object top levels,
/// floating point and exponent numbers, nested arrays, heterogeneous arrays,
/// duplicate property names, over-deep nesting, over-long strings, over-wide
/// objects, and the property names <c>__proto__</c>, <c>constructor</c>, and
/// <c>prototype</c> at any depth.
/// </summary>
internal static class StrictJson
{
    private static readonly string[] ForbiddenPropertyNames =
    [
        "__proto__",
        "constructor",
        "prototype",
    ];

    private static readonly UTF8Encoding StrictUtf8 = new(
        encoderShouldEmitUTF8Identifier: false,
        throwOnInvalidBytes: true);

    internal static bool TryDecodeUtf8(
        ReadOnlySpan<byte> payload,
        out string text,
        out RefusalCode code)
    {
        if (payload.Length >= 3 && payload[0] == 0xEF && payload[1] == 0xBB && payload[2] == 0xBF)
        {
            text = string.Empty;
            code = RefusalCode.InvalidUtf8;
            return false;
        }

        try
        {
            text = StrictUtf8.GetString(payload);
        }
        catch (DecoderFallbackException)
        {
            text = string.Empty;
            code = RefusalCode.InvalidUtf8;
            return false;
        }

        code = RefusalCode.None;
        return true;
    }

    internal static bool TryParseObject(
        ReadOnlySpan<byte> payload,
        out StrictObject result,
        out RefusalCode code) =>
        TryParseObject(payload, StrictLimits.Protocol, out result, out code);

    internal static bool TryParseObject(
        ReadOnlySpan<byte> payload,
        StrictLimits limits,
        out StrictObject result,
        out RefusalCode code)
    {
        result = new StrictObject();
        if (!TryDecodeUtf8(payload, out _, out code))
        {
            return false;
        }

        JsonReaderOptions options = new()
        {
            AllowTrailingCommas = false,
            CommentHandling = JsonCommentHandling.Disallow,

            // Two levels of headroom so the explicit depth check below produces
            // the specific `json-depth-exceeded` code instead of the reader's
            // generic malformed-document exception.
            MaxDepth = limits.MaxDepth + 2,
        };

        try
        {
            Utf8JsonReader reader = new(payload, options);
            if (!reader.Read() || reader.TokenType != JsonTokenType.StartObject)
            {
                code = RefusalCode.TypeMismatch;
                return false;
            }

            if (!TryReadObject(ref reader, limits, 1, out StrictObject parsed, out code))
            {
                return false;
            }

            if (reader.Read())
            {
                code = RefusalCode.InvalidJson;
                return false;
            }

            result = parsed;
            code = RefusalCode.None;
            return true;
        }
        catch (JsonException)
        {
            code = RefusalCode.InvalidJson;
            return false;
        }
    }

    private static bool TryReadObject(
        ref Utf8JsonReader reader,
        StrictLimits limits,
        int depth,
        out StrictObject result,
        out RefusalCode code)
    {
        result = new StrictObject();
        if (depth > limits.MaxDepth)
        {
            code = RefusalCode.JsonDepthExceeded;
            return false;
        }

        int members = 0;
        while (reader.Read())
        {
            if (reader.TokenType == JsonTokenType.EndObject)
            {
                code = RefusalCode.None;
                return true;
            }

            if (reader.TokenType != JsonTokenType.PropertyName)
            {
                code = RefusalCode.InvalidJson;
                return false;
            }

            string name = reader.GetString() ?? string.Empty;
            if (!IsAcceptablePropertyName(name, out code))
            {
                return false;
            }

            members++;
            if (members > limits.MaxObjectMembers)
            {
                code = RefusalCode.ValueOutOfRange;
                return false;
            }

            if (!TryReadValue(ref reader, limits, depth, out StrictValue value, out code))
            {
                return false;
            }

            if (!result.TryAdd(name, value))
            {
                code = RefusalCode.DuplicateProperty;
                return false;
            }
        }

        code = RefusalCode.InvalidJson;
        return false;
    }

    private static bool TryReadValue(
        ref Utf8JsonReader reader,
        StrictLimits limits,
        int depth,
        out StrictValue value,
        out RefusalCode code)
    {
        value = StrictValue.Null;
        if (!reader.Read())
        {
            code = RefusalCode.InvalidJson;
            return false;
        }

        switch (reader.TokenType)
        {
            case JsonTokenType.Null:
                value = StrictValue.Null;
                code = RefusalCode.None;
                return true;
            case JsonTokenType.True:
                value = StrictValue.Of(true);
                code = RefusalCode.None;
                return true;
            case JsonTokenType.False:
                value = StrictValue.Of(false);
                code = RefusalCode.None;
                return true;
            case JsonTokenType.Number:
                if (!reader.TryGetInt64(out long number))
                {
                    code = RefusalCode.ValueOutOfRange;
                    return false;
                }

                value = StrictValue.Of(number);
                code = RefusalCode.None;
                return true;
            case JsonTokenType.String:
                string text = reader.GetString() ?? string.Empty;
                if (text.Length > limits.MaxStringLength)
                {
                    code = RefusalCode.ValueOutOfRange;
                    return false;
                }

                value = StrictValue.Of(text);
                code = RefusalCode.None;
                return true;
            case JsonTokenType.StartArray:
                return TryReadArray(ref reader, limits, depth, out value, out code);
            case JsonTokenType.StartObject:
                if (!TryReadObject(ref reader, limits, depth + 1, out StrictObject child, out code))
                {
                    return false;
                }

                value = StrictValue.Of(child);
                return true;
            default:
                code = RefusalCode.InvalidJson;
                return false;
        }
    }

    private static bool TryReadArray(
        ref Utf8JsonReader reader,
        StrictLimits limits,
        int depth,
        out StrictValue value,
        out RefusalCode code)
    {
        value = StrictValue.Null;
        List<string> strings = [];
        List<StrictObject> objects = [];
        bool sawString = false;
        bool sawObject = false;

        while (reader.Read())
        {
            if (reader.TokenType == JsonTokenType.EndArray)
            {
                value = sawObject ? StrictValue.Of(objects) : StrictValue.Of(strings);
                code = RefusalCode.None;
                return true;
            }

            if (reader.TokenType == JsonTokenType.String)
            {
                if (sawObject)
                {
                    code = RefusalCode.TypeMismatch;
                    return false;
                }

                sawString = true;
                string text = reader.GetString() ?? string.Empty;
                if (text.Length > limits.MaxStringLength)
                {
                    code = RefusalCode.ValueOutOfRange;
                    return false;
                }

                strings.Add(text);
                if (strings.Count > limits.MaxArrayLength)
                {
                    code = RefusalCode.ValueOutOfRange;
                    return false;
                }

                continue;
            }

            if (reader.TokenType == JsonTokenType.StartObject)
            {
                if (sawString || !limits.AllowObjectArrays)
                {
                    code = RefusalCode.TypeMismatch;
                    return false;
                }

                sawObject = true;
                if (!TryReadObject(ref reader, limits, depth + 1, out StrictObject child, out code))
                {
                    return false;
                }

                objects.Add(child);
                if (objects.Count > limits.MaxArrayLength)
                {
                    code = RefusalCode.ValueOutOfRange;
                    return false;
                }

                continue;
            }

            code = RefusalCode.TypeMismatch;
            return false;
        }

        code = RefusalCode.InvalidJson;
        return false;
    }

    private static bool IsAcceptablePropertyName(string name, out RefusalCode code)
    {
        foreach (string forbidden in ForbiddenPropertyNames)
        {
            if (string.Equals(forbidden, name, StringComparison.Ordinal))
            {
                code = RefusalCode.ForbiddenPropertyName;
                return false;
            }
        }

        if (name.Length is 0 or > 64)
        {
            code = RefusalCode.ValueOutOfRange;
            return false;
        }

        if (!char.IsAsciiLetterLower(name[0]))
        {
            code = RefusalCode.UnknownProperty;
            return false;
        }

        foreach (char character in name)
        {
            if (!char.IsAsciiLetterOrDigit(character))
            {
                code = RefusalCode.UnknownProperty;
                return false;
            }
        }

        code = RefusalCode.None;
        return true;
    }

    /// <summary>Lowercase hexadecimal of an exact length. No uppercase, no prefix.</summary>
    internal static bool IsLowercaseHex(string? value, int length)
    {
        if (value is null || value.Length != length)
        {
            return false;
        }

        foreach (char character in value)
        {
            if (!char.IsAsciiDigit(character) && character is < 'a' or > 'f')
            {
                return false;
            }
        }

        return true;
    }
}

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace AiDevOs.WindowsProofInstaller;

/// <summary>The closed set of value shapes canonical JSON can express.</summary>
internal enum CanonicalKind
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
/// An immutable canonical JSON value. Only the shapes the recovery-record and
/// artifact-manifest formats actually use exist: there is no floating point,
/// no nested array, and no heterogeneous array, so canonical serialization has
/// no representation choices to make.
/// </summary>
internal sealed class CanonicalValue
{
    private CanonicalValue(
        CanonicalKind kind,
        bool boolean,
        long integer,
        string? text,
        IReadOnlyList<string>? strings,
        IReadOnlyList<CanonicalObject>? objects,
        CanonicalObject? child)
    {
        Kind = kind;
        Boolean = boolean;
        Integer = integer;
        Text = text;
        Strings = strings;
        Objects = objects;
        Child = child;
    }

    internal CanonicalKind Kind { get; }

    internal bool Boolean { get; }

    internal long Integer { get; }

    internal string? Text { get; }

    internal IReadOnlyList<string>? Strings { get; }

    internal IReadOnlyList<CanonicalObject>? Objects { get; }

    internal CanonicalObject? Child { get; }

    internal static CanonicalValue Null { get; } =
        new(CanonicalKind.Null, false, 0, null, null, null, null);

    internal static CanonicalValue Of(bool value) =>
        new(CanonicalKind.Boolean, value, 0, null, null, null, null);

    internal static CanonicalValue Of(long value) =>
        new(CanonicalKind.Integer, false, value, null, null, null, null);

    internal static CanonicalValue Of(string value) =>
        new(CanonicalKind.String, false, 0, value, null, null, null);

    internal static CanonicalValue Of(IReadOnlyList<string> values) =>
        new(CanonicalKind.StringArray, false, 0, null, values, null, null);

    internal static CanonicalValue Of(IReadOnlyList<CanonicalObject> values) =>
        new(CanonicalKind.ObjectArray, false, 0, null, null, values, null);

    internal static CanonicalValue Of(CanonicalObject value) =>
        new(CanonicalKind.Object, false, 0, null, null, null, value);
}

/// <summary>
/// A canonical JSON object. Members are stored in an ordinal-sorted map, so
/// insertion order cannot influence the serialized bytes and two structurally
/// identical objects always serialize to the same bytes.
/// </summary>
internal sealed class CanonicalObject
{
    private readonly SortedDictionary<string, CanonicalValue> members =
        new(StringComparer.Ordinal);

    internal int Count => members.Count;

    internal CanonicalObject Set(string name, CanonicalValue value)
    {
        members[name] = value;
        return this;
    }

    internal CanonicalObject Set(string name, string value) => Set(name, CanonicalValue.Of(value));

    internal CanonicalObject Set(string name, long value) => Set(name, CanonicalValue.Of(value));

    internal CanonicalObject Set(string name, bool value) => Set(name, CanonicalValue.Of(value));

    internal CanonicalObject Set(string name, IReadOnlyList<string> value) =>
        Set(name, CanonicalValue.Of(value));

    internal CanonicalObject Set(string name, IReadOnlyList<CanonicalObject> value) =>
        Set(name, CanonicalValue.Of(value));

    internal IEnumerable<KeyValuePair<string, CanonicalValue>> Members => members;
}

/// <summary>
/// Canonical JSON serialization: ordinal-sorted member names, no insignificant
/// whitespace, integers only, and a fixed minimal escape table. The output is
/// the input to every digest in the recovery-record and manifest formats, so it
/// must be a pure function of structure.
/// </summary>
internal static class CanonicalJson
{
    internal static byte[] Serialize(CanonicalObject value)
    {
        StringBuilder builder = new();
        WriteObject(builder, value);
        return new UTF8Encoding(encoderShouldEmitUTF8Identifier: false).GetBytes(
            builder.ToString());
    }

    internal static string SerializeToString(CanonicalObject value)
    {
        StringBuilder builder = new();
        WriteObject(builder, value);
        return builder.ToString();
    }

    private static void WriteObject(StringBuilder builder, CanonicalObject value)
    {
        builder.Append('{');
        bool first = true;
        foreach (KeyValuePair<string, CanonicalValue> member in value.Members)
        {
            if (!first)
            {
                builder.Append(',');
            }

            first = false;
            WriteString(builder, member.Key);
            builder.Append(':');
            WriteValue(builder, member.Value);
        }

        builder.Append('}');
    }

    private static void WriteValue(StringBuilder builder, CanonicalValue value)
    {
        switch (value.Kind)
        {
            case CanonicalKind.Null:
                builder.Append("null");
                break;
            case CanonicalKind.Boolean:
                builder.Append(value.Boolean ? "true" : "false");
                break;
            case CanonicalKind.Integer:
                builder.Append(value.Integer.ToString(CultureInfo.InvariantCulture));
                break;
            case CanonicalKind.String:
                WriteString(builder, value.Text ?? string.Empty);
                break;
            case CanonicalKind.StringArray:
                WriteStringArray(builder, value.Strings);
                break;
            case CanonicalKind.ObjectArray:
                WriteObjectArray(builder, value.Objects);
                break;
            case CanonicalKind.Object:
                WriteObject(builder, value.Child ?? new CanonicalObject());
                break;
            default:
                builder.Append("null");
                break;
        }
    }

    private static void WriteStringArray(StringBuilder builder, IReadOnlyList<string>? values)
    {
        builder.Append('[');
        if (values is not null)
        {
            for (int index = 0; index < values.Count; index++)
            {
                if (index > 0)
                {
                    builder.Append(',');
                }

                WriteString(builder, values[index]);
            }
        }

        builder.Append(']');
    }

    private static void WriteObjectArray(StringBuilder builder, IReadOnlyList<CanonicalObject>? values)
    {
        builder.Append('[');
        if (values is not null)
        {
            for (int index = 0; index < values.Count; index++)
            {
                if (index > 0)
                {
                    builder.Append(',');
                }

                WriteObject(builder, values[index]);
            }
        }

        builder.Append(']');
    }

    private static void WriteString(StringBuilder builder, string value)
    {
        builder.Append('"');
        foreach (char character in value)
        {
            switch (character)
            {
                case '"':
                    builder.Append("\\\"");
                    break;
                case '\\':
                    builder.Append("\\\\");
                    break;
                case '\b':
                    builder.Append("\\b");
                    break;
                case '\f':
                    builder.Append("\\f");
                    break;
                case '\n':
                    builder.Append("\\n");
                    break;
                case '\r':
                    builder.Append("\\r");
                    break;
                case '\t':
                    builder.Append("\\t");
                    break;
                default:
                    if (character < ' ')
                    {
                        builder.Append("\\u");
                        builder.Append(((int)character).ToString("x4", CultureInfo.InvariantCulture));
                    }
                    else
                    {
                        builder.Append(character);
                    }

                    break;
            }
        }

        builder.Append('"');
    }
}

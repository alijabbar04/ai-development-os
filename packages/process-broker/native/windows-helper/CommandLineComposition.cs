using System;
using System.Collections.Generic;
using System.Text;

namespace AiDevOs.WindowsHelper;

/// <summary>
/// Command-line reconstruction (ADR 0017 section 4.7).
///
/// Windows has no argv-array process-creation API: <c>CreateProcessW</c> takes
/// one <c>lpCommandLine</c> string. The helper therefore never accepts a
/// caller-supplied command *string* — it accepts an exact argument array and
/// builds the single string itself using the documented
/// <c>CommandLineToArgvW</c> inverse quoting rules, while passing an exact
/// <c>lpApplicationName</c> so the command line is never used for image
/// resolution. This is a stated residual, not a claim of avoidance.
///
/// Honest limitation: <see cref="TryParse"/> is a managed implementation of the
/// documented rules, not the real <c>CommandLineToArgvW</c>. The round-trip
/// vectors therefore prove the composer and the documented rules agree with
/// each other; verifying them against the actual Win32 function requires
/// executing native interop and is deliberately not done in this checkpoint.
/// </summary>
internal static class CommandLineComposition
{
    internal const int MaxArgumentCount = 64;
    internal const int MaxArgumentLength = 1_024;
    internal const int MaxCommandLineLength = 8_192;

    /// <summary>
    /// Builds the single command-line string for an exact argument array.
    /// </summary>
    internal static bool TryCompose(
        IReadOnlyList<string> argv,
        out string commandLine,
        out RefusalCode code)
    {
        commandLine = string.Empty;
        if (argv is null || argv.Count == 0 || argv.Count > MaxArgumentCount)
        {
            code = RefusalCode.ArgumentInvalid;
            return false;
        }

        for (int index = 0; index < argv.Count; index++)
        {
            string argument = argv[index];
            if (argument is null || argument.Length > MaxArgumentLength)
            {
                code = RefusalCode.ArgumentInvalid;
                return false;
            }

            foreach (char character in argument)
            {
                // Control characters, including NUL, cannot survive a command
                // line and are refused rather than silently stripped. Tab is
                // the single exception: it is ordinary argument whitespace on
                // Windows and is handled by quoting.
                if (character < ' ' && character != '\t')
                {
                    code = RefusalCode.ArgumentInvalid;
                    return false;
                }
            }

            // CommandLineToArgvW parses argv[0] with a different, weaker rule:
            // a leading quote runs to the next quote and backslashes are not
            // escapes. A quote inside argv[0] therefore has no round-trippable
            // encoding, so it is refused. Every real argv[0] here is a file
            // name from the verified bundle, which cannot contain a quote.
            if (index == 0 && argument.Contains('"', StringComparison.Ordinal))
            {
                code = RefusalCode.ArgumentInvalid;
                return false;
            }

            if (index == 0 && argument.Length == 0)
            {
                code = RefusalCode.ArgumentInvalid;
                return false;
            }
        }

        StringBuilder builder = new();
        for (int index = 0; index < argv.Count; index++)
        {
            if (index > 0)
            {
                builder.Append(' ');
            }

            AppendQuoted(builder, argv[index]);
        }

        if (builder.Length > MaxCommandLineLength)
        {
            code = RefusalCode.ValueOutOfRange;
            return false;
        }

        commandLine = builder.ToString();
        code = RefusalCode.None;
        return true;
    }

    private static void AppendQuoted(StringBuilder builder, string argument)
    {
        if (argument.Length > 0 && !NeedsQuoting(argument))
        {
            builder.Append(argument);
            return;
        }

        builder.Append('"');
        int index = 0;
        while (true)
        {
            int backslashes = 0;
            while (index < argument.Length && argument[index] == '\\')
            {
                index++;
                backslashes++;
            }

            if (index == argument.Length)
            {
                // Escape every backslash so the closing quote stays a
                // metacharacter rather than being escaped by a stray backslash.
                builder.Append('\\', backslashes * 2);
                break;
            }

            if (argument[index] == '"')
            {
                builder.Append('\\', (backslashes * 2) + 1);
                builder.Append('"');
            }
            else
            {
                builder.Append('\\', backslashes);
                builder.Append(argument[index]);
            }

            index++;
        }

        builder.Append('"');
    }

    private static bool NeedsQuoting(string argument)
    {
        foreach (char character in argument)
        {
            if (character is ' ' or '\t' or '"')
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// The documented inverse: splits a command line the way
    /// <c>CommandLineToArgvW</c> documents, including the distinct argv[0]
    /// rule. Used only by the read-only round-trip vectors.
    /// </summary>
    internal static IReadOnlyList<string> TryParse(string commandLine)
    {
        List<string> arguments = [];
        if (commandLine.Length == 0)
        {
            return arguments;
        }

        int index = 0;
        while (index < commandLine.Length && commandLine[index] is ' ' or '\t')
        {
            index++;
        }

        StringBuilder first = new();
        if (index < commandLine.Length && commandLine[index] == '"')
        {
            index++;
            while (index < commandLine.Length && commandLine[index] != '"')
            {
                first.Append(commandLine[index]);
                index++;
            }

            if (index < commandLine.Length)
            {
                index++;
            }
        }
        else
        {
            while (index < commandLine.Length && commandLine[index] is not (' ' or '\t'))
            {
                first.Append(commandLine[index]);
                index++;
            }
        }

        arguments.Add(first.ToString());

        while (index < commandLine.Length)
        {
            while (index < commandLine.Length && commandLine[index] is ' ' or '\t')
            {
                index++;
            }

            if (index >= commandLine.Length)
            {
                break;
            }

            StringBuilder current = new();
            bool quoted = false;
            while (index < commandLine.Length)
            {
                char character = commandLine[index];
                if (character == '\\')
                {
                    int backslashes = 0;
                    while (index < commandLine.Length && commandLine[index] == '\\')
                    {
                        index++;
                        backslashes++;
                    }

                    if (index < commandLine.Length && commandLine[index] == '"')
                    {
                        current.Append('\\', backslashes / 2);
                        if (backslashes % 2 == 1)
                        {
                            current.Append('"');
                        }
                        else
                        {
                            quoted = !quoted;
                        }

                        index++;
                    }
                    else
                    {
                        current.Append('\\', backslashes);
                    }

                    continue;
                }

                if (character == '"')
                {
                    quoted = !quoted;
                    index++;
                    continue;
                }

                if (!quoted && character is ' ' or '\t')
                {
                    break;
                }

                current.Append(character);
                index++;
            }

            arguments.Add(current.ToString());
        }

        return arguments;
    }

    internal static bool RoundTrips(IReadOnlyList<string> argv)
    {
        if (!TryCompose(argv, out string commandLine, out _))
        {
            return false;
        }

        IReadOnlyList<string> parsed = TryParse(commandLine);
        if (parsed.Count != argv.Count)
        {
            return false;
        }

        for (int index = 0; index < argv.Count; index++)
        {
            if (!string.Equals(parsed[index], argv[index], StringComparison.Ordinal))
            {
                return false;
            }
        }

        return true;
    }
}

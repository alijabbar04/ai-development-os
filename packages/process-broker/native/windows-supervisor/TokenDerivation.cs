using System;
using System.Collections.Generic;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace AiDevOs.WindowsSupervisor;

/// <summary>
/// Pure derivation of every recovery-relevant name from the 128-bit operation
/// token (ADR 0017 sections 2.7 and 5).
///
/// Recovery authority is exactly the exact Job handle, the exact helper process
/// handle, and values derived here. Nothing in this file reads the filesystem,
/// the registry, the environment, or the process list, and nothing here accepts
/// a caller-supplied name: a hostile or substituted journal can therefore at
/// most name a different token, and a different token derives a different,
/// non-existent name.
/// </summary>
internal static class TokenDerivation
{
    private const string DerivationPrefix = "ai-dev-os/stage-17/windows-production/v1/";
    private const string ProfilePurpose = "appcontainer-profile";
    private const string StagingPurpose = "staging-root";
    private const string RequestFilePurpose = "request-file";
    private const string ResponseFilePurpose = "response-file";

    internal static bool IsValidOperationToken(string? token) =>
        StrictJson.IsLowercaseHex(token, ProtocolContract.OperationTokenHexLength);

    /// <summary>
    /// Derives a fixed-width lowercase hexadecimal label for one purpose. The
    /// purpose set is closed: the four constants above are the only callers.
    /// </summary>
    internal static string Derive(string purpose, string token)
    {
        byte[] material = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false)
            .GetBytes(string.Concat(DerivationPrefix, purpose, "/", token));
        byte[] digest = SHA256.HashData(material);
        StringBuilder builder = new(ProtocolContract.DerivedNameHexLength);
        for (int index = 0; index < ProtocolContract.DerivedNameHexLength / 2; index++)
        {
            builder.Append(digest[index].ToString("x2", CultureInfo.InvariantCulture));
        }

        return builder.ToString();
    }

    internal static string ProfileName(string token) =>
        string.Concat("AiDevOs.S17.", Derive(ProfilePurpose, token));

    internal static string StagingRootLeaf(string token) =>
        string.Concat("aidevos-s17-", Derive(StagingPurpose, token));

    internal static string JournalFileName(string token) => string.Concat(token, ".journal");

    internal static IReadOnlyList<string> StagedFileNames(string token) =>
    [
        string.Concat("req-", Derive(RequestFilePurpose, token), ".bin"),
        string.Concat("res-", Derive(ResponseFilePurpose, token), ".bin"),
    ];

    internal static bool StagedFileNamesEqual(IReadOnlyList<string>? candidate, string token)
    {
        if (candidate is null)
        {
            return false;
        }

        IReadOnlyList<string> expected = StagedFileNames(token);
        if (candidate.Count != expected.Count)
        {
            return false;
        }

        for (int index = 0; index < expected.Count; index++)
        {
            if (!string.Equals(expected[index], candidate[index], StringComparison.Ordinal))
            {
                return false;
            }
        }

        return true;
    }
}

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace AiDevOs.WindowsHelper;

/// <summary>
/// Helper-specific self-test vectors: identity cross-checking, the closed
/// derived staging plan, command-line reconstruction round-trips, and proof
/// that every helper-owned mutating operation refuses.
///
/// Like the shared core, this suite runs entirely in memory.
/// </summary>
internal static class RoleConformance
{
    private const string Token = "0123456789abcdef0123456789abcdef";
    private static readonly UTF8Encoding Utf8 = new(encoderShouldEmitUTF8Identifier: false);

    internal static ConformanceReport Run()
    {
        List<ConformanceVector> vectors =
        [
            new ConformanceVector("role/component-name", "windows-helper", ComponentIdentity.ComponentName),
            new ConformanceVector("role/role-name", "helper", ComponentIdentity.Role),
            new ConformanceVector("role/runtime-identifier", "win-x64", ComponentIdentity.RuntimeIdentifier),
            new ConformanceVector("role/signer-state", "unsigned-candidate", ComponentIdentity.SignerState),
            new ConformanceVector(
                "role/manifest-identity-match",
                "none",
                VerifyIdentity(ManifestFor(ComponentIdentity.ComponentName))),
            new ConformanceVector(
                "role/manifest-identity-other-component",
                "manifest-identity-mismatch",
                VerifyIdentity(ManifestFor("windows-supervisor"))),
            new ConformanceVector(
                "role/manifest-identity-production-eligible",
                "manifest-identity-mismatch",
                VerifyIdentity(ManifestFor(ComponentIdentity.ComponentName).Replace(
                    "\"productionEligible\":false",
                    "\"productionEligible\":true",
                    StringComparison.Ordinal))),
            new ConformanceVector(
                "role/manifest-identity-claimed-signature",
                "manifest-identity-mismatch",
                VerifyIdentity(ManifestFor(ComponentIdentity.ComponentName).Replace(
                    "\"signerState\":\"unsigned-candidate\"",
                    "\"signerState\":\"authenticode\"",
                    StringComparison.Ordinal))),
            new ConformanceVector(
                "role/manifest-identity-wrong-rid",
                "manifest-identity-mismatch",
                VerifyIdentity(ManifestFor(ComponentIdentity.ComponentName).Replace(
                    "\"rid\":\"win-x64\"",
                    "\"rid\":\"win-arm64\"",
                    StringComparison.Ordinal))),
            new ConformanceVector(
                "role/manifest-identity-wrong-architecture",
                "manifest-identity-mismatch",
                VerifyIdentity(ManifestFor(ComponentIdentity.ComponentName).Replace(
                    "\"architecture\":\"x64\"",
                    "\"architecture\":\"arm64\"",
                    StringComparison.Ordinal))),
            new ConformanceVector(
                "role/manifest-identity-wrong-source-version",
                "manifest-identity-mismatch",
                VerifyIdentity(ManifestFor(ComponentIdentity.ComponentName).Replace(
                    "\"sourceVersion\":\"1.0.0\"",
                    "\"sourceVersion\":\"2.0.0\"",
                    StringComparison.Ordinal))),
            new ConformanceVector(
                "role/manifest-identity-wrong-build-recipe",
                "manifest-identity-mismatch",
                VerifyIdentity(ManifestFor(ComponentIdentity.ComponentName).Replace(
                    "\"buildRecipeVersion\":1",
                    "\"buildRecipeVersion\":2",
                    StringComparison.Ordinal))),
        ];

        AddMutationVectors(vectors);
        AddStagingPlanVectors(vectors);
        AddCommandLineVectors(vectors);
        return new ConformanceReport("windows-helper-role-v1", vectors);
    }

    private static void AddMutationVectors(List<ConformanceVector> vectors)
    {
        foreach (HelperMutatingOperation operation in Enum.GetValues<HelperMutatingOperation>())
        {
            MutatingOperationOutcome outcome = HelperOperations.Execute(operation, Token);
            vectors.Add(new ConformanceVector(
                string.Concat("role/mutating-refused/", operation.ToString().ToLowerInvariant()),
                "false:mutating-operations-structurally-disabled",
                string.Concat(
                    outcome.Performed ? "true:" : "false:",
                    ProtocolNames.Of(outcome.Refusal))));
        }

        MutatingOperationOutcome malformed = HelperOperations.Execute(
            HelperMutatingOperation.CreateAppContainerProfile,
            "not-a-token");
        vectors.Add(new ConformanceVector(
            "role/mutating-refuses-malformed-token-first",
            "false:token-malformed",
            string.Concat(
                malformed.Performed ? "true:" : "false:",
                ProtocolNames.Of(malformed.Refusal))));
    }

    private static void AddStagingPlanVectors(List<ConformanceVector> vectors)
    {
        StagingPlan plan = StagingPlan.For(Token);
        vectors.Add(new ConformanceVector(
            "role/staging-plan-closed-derived-set",
            "{\"profileName\":\"" + TokenDerivation.ProfileName(Token) + "\"," +
            "\"stagedFileNames\":[\"" + TokenDerivation.StagedFileNames(Token)[0] + "\",\"" +
            TokenDerivation.StagedFileNames(Token)[1] + "\"]," +
            "\"stagingRootLeaf\":\"" + TokenDerivation.StagingRootLeaf(Token) + "\",\"valid\":true}",
            CanonicalJson.SerializeToString(plan.ToCanonical())));
        vectors.Add(new ConformanceVector(
            "role/staging-plan-rejects-malformed-token",
            "false",
            StagingPlan.For("nope").Valid ? "true" : "false"));

        IReadOnlyList<MutatingOperationOutcome> outcomes = HelperOperations.ExecutePlan(plan);
        vectors.Add(new ConformanceVector(
            "role/staging-plan-execution-performs-nothing",
            "12:false",
            string.Concat(
                outcomes.Count.ToString(CultureInfo.InvariantCulture),
                ":",
                HelperOperations.AnyOperationPerformed(outcomes) ? "true" : "false")));
    }

    private static void AddCommandLineVectors(List<ConformanceVector> vectors)
    {
        AddCompose(vectors, "plain", ["tool.exe", "alpha", "beta"], "tool.exe alpha beta");
        AddCompose(vectors, "space", ["tool.exe", "a b"], "tool.exe \"a b\"");
        AddCompose(vectors, "tab", ["tool.exe", "a\tb"], "tool.exe \"a\tb\"");
        AddCompose(vectors, "empty-argument", ["tool.exe", ""], "tool.exe \"\"");
        AddCompose(vectors, "embedded-quote", ["tool.exe", "a\"b"], "tool.exe \"a\\\"b\"");
        AddCompose(vectors, "trailing-backslash", ["tool.exe", "a\\"], "tool.exe a\\");
        AddCompose(
            vectors,
            "trailing-backslash-with-space",
            ["tool.exe", "a b\\"],
            "tool.exe \"a b\\\\\"");
        AddCompose(
            vectors,
            "backslashes-before-quote",
            ["tool.exe", "a\\\\\"b"],
            "tool.exe \"a\\\\\\\\\\\"b\"");
        AddCompose(
            vectors,
            "quoted-path-like",
            ["tool.exe", "C:\\Program Files\\x\\"],
            "tool.exe \"C:\\Program Files\\x\\\\\"");

        string[][] roundTripCases =
        [
            ["tool.exe"],
            ["tool.exe", "alpha", "beta"],
            ["tool.exe", "a b", "c\td"],
            ["tool.exe", "", "", "x"],
            ["tool.exe", "a\"b", "\"", "\"\""],
            ["tool.exe", "a\\", "b\\\\", "c\\\\\\"],
            ["tool.exe", "a\\\"b", "\\\\\"", "x y\\"],
            ["tool with space.exe", "arg"],
            ["tool.exe", "--flag=value with spaces", "-x", "\\\\server\\share\\path"],
        ];

        int index = 0;
        foreach (string[] argv in roundTripCases)
        {
            vectors.Add(new ConformanceVector(
                string.Concat(
                    "role/command-line-roundtrip/",
                    index.ToString("d2", CultureInfo.InvariantCulture)),
                "true",
                CommandLineComposition.RoundTrips(argv) ? "true" : "false"));
            index++;
        }

        vectors.Add(new ConformanceVector(
            "role/command-line-refuses-empty-argv",
            "false:argument-invalid",
            Compose([])));
        vectors.Add(new ConformanceVector(
            "role/command-line-refuses-quote-in-argv0",
            "false:argument-invalid",
            Compose(["to\"ol.exe", "a"])));
        vectors.Add(new ConformanceVector(
            "role/command-line-refuses-empty-argv0",
            "false:argument-invalid",
            Compose(["", "a"])));
        vectors.Add(new ConformanceVector(
            "role/command-line-refuses-control-character",
            "false:argument-invalid",
            Compose(["tool.exe", "a\nb"])));
        vectors.Add(new ConformanceVector(
            "role/command-line-refuses-too-many-arguments",
            "false:argument-invalid",
            Compose(ManyArguments(CommandLineComposition.MaxArgumentCount + 1))));
        vectors.Add(new ConformanceVector(
            "role/command-line-refuses-overlong-argument",
            "false:argument-invalid",
            Compose(["tool.exe", new string('x', CommandLineComposition.MaxArgumentLength + 1)])));
        vectors.Add(new ConformanceVector(
            "role/command-line-refuses-overlong-command-line",
            "false:value-out-of-range",
            Compose(ManyArguments(CommandLineComposition.MaxArgumentCount, 200))));
    }

    private static string[] ManyArguments(int count, int length = 1)
    {
        string[] argv = new string[count];
        argv[0] = "tool.exe";
        for (int index = 1; index < count; index++)
        {
            argv[index] = new string('x', length);
        }

        return argv;
    }

    private static void AddCompose(
        List<ConformanceVector> vectors,
        string name,
        string[] argv,
        string expected)
    {
        vectors.Add(new ConformanceVector(
            string.Concat("role/command-line-compose/", name),
            string.Concat("true:", expected),
            Compose(argv)));
    }

    private static string Compose(IReadOnlyList<string> argv)
    {
        if (!CommandLineComposition.TryCompose(argv, out string commandLine, out RefusalCode code))
        {
            return string.Concat("false:", ProtocolNames.Of(code));
        }

        return string.Concat("true:", commandLine);
    }

    private static string ManifestFor(string component) =>
        CoreConformance.ManifestFixtureJson.Replace(
            "\"component\":\"windows-supervisor\"",
            string.Concat("\"component\":\"", component, "\""),
            StringComparison.Ordinal);

    private static string VerifyIdentity(string manifestJson)
    {
        if (!ArtifactManifestReader.TryParse(
            Utf8.GetBytes(manifestJson),
            out ArtifactManifest manifest,
            out RefusalCode code))
        {
            return string.Concat("parse:", ProtocolNames.Of(code));
        }

        return ProtocolNames.Of(ArtifactManifestVerifier.VerifyIdentity(manifest));
    }
}

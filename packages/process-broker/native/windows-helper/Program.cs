using System;
using System.Collections.Generic;
using System.Text;

namespace AiDevOs.WindowsHelper;

/// <summary>
/// Entry point for a Windows production component candidate. The component's
/// own identity comes from <see cref="ComponentIdentity"/>.
///
/// Two public inspection commands are read-only:
///
///   self-test        in-memory conformance over the parser, the state
///                    machine, canonical serialization, the recovery-record
///                    format, and manifest identity logic;
///   describe-artifact the component's own fixed identity.
///
/// The role-specific operational command is deliberately separate from the
/// proof capability. It accepts only inherited native handles and identities
/// derived from the installed closure; it has no arbitrary executable, path,
/// shell, PATH lookup, plugin, runtime-download, or provider surface. The
/// proof-only controller owns fault injection. This sealed component owns the
/// ordinary lifecycle it will also use in production.
/// </summary>
internal static class Program
{
    private const int SuccessExitCode = 0;
    private const int SelfTestFailedExitCode = 1;
    private const int UnknownCommandExitCode = 64;

    private static readonly UTF8Encoding Utf8 = new(encoderShouldEmitUTF8Identifier: false);

    internal static int Main(string[] args)
    {
        if (args is null || args.Length == 0)
        {
            return RefuseUnknownCommand();
        }

        if (args.Length == 1)
        {
            return args[0] switch
            {
                "self-test" => RunSelfTest(),
                "describe-artifact" => DescribeArtifact(),
                _ => RefuseUnknownCommand(),
            };
        }

        return RoleRuntime.TryDispatch(args, out int exitCode)
            ? exitCode
            : RefuseUnknownCommand();
    }

    private static int RunSelfTest()
    {
        ConformanceReport core = CoreConformance.Run();
        ConformanceReport role = RoleConformance.Run();
        bool operationalRuntimePassed = RoleRuntime.RunReadOnlySelfTest();
        bool passed = core.Passed && role.Passed && operationalRuntimePassed;

        List<string> failed = [];
        failed.AddRange(core.FailedNames);
        failed.AddRange(role.FailedNames);
        failed.Sort(StringComparer.Ordinal);

        CanonicalObject result = MutationGate.Describe(new CanonicalObject())
            .Set("component", ComponentIdentity.ComponentName)
            .Set("coreConformanceDigest", core.Digest)
            .Set("coreVectorCount", core.Count)
            .Set("failedVectorCount", core.FailedCount + role.FailedCount)
            .Set("failedVectors", failed)
            .Set("hostStateCreated", false)
            .Set("manifestFixtureFingerprint", CoreConformance.ManifestFixtureFingerprint())
            .Set("reviewedProofMutationAuthorized", MutationGate.MutatingOperationsPermitted)
            .Set("operationalLifecycleCompiledIn", true)
            .Set("operationalRuntimeSelfTestPassed", operationalRuntimePassed)
            .Set("protocolVersion", ProtocolContract.ProtocolVersion)
            .Set("roleConformanceDigest", role.Digest)
            .Set("roleVectorCount", role.Count)
            .Set("schemaVersion", ProtocolContract.SchemaVersion)
            .Set("status", passed ? "passed" : "failed");

        Write(result);
        return passed ? SuccessExitCode : SelfTestFailedExitCode;
    }

    private static int DescribeArtifact()
    {
        CanonicalObject result = MutationGate.Describe(new CanonicalObject())
            .Set("architecture", ComponentIdentity.Architecture)
            .Set("buildRecipeVersion", ComponentIdentity.BuildRecipeVersion)
            .Set("component", ComponentIdentity.ComponentName)
            .Set("manifestKind", ArtifactManifest.ManifestKind)
            .Set("manifestSchemaVersion", ProtocolContract.SchemaVersion)
            .Set("operationalLifecycleCompiledIn", true)
            .Set("platform", ComponentIdentity.Platform)
            .Set("productionEligible", false)
            .Set("protocolVersion", ProtocolContract.ProtocolVersion)
            .Set("rid", ComponentIdentity.RuntimeIdentifier)
            .Set("role", ComponentIdentity.Role)
            .Set("schemaVersion", ProtocolContract.SchemaVersion)
            .Set("signerState", ComponentIdentity.SignerState)
            .Set("sourceVersion", ComponentIdentity.SourceVersion)
            .Set("status", "described");

        Write(result);
        return SuccessExitCode;
    }

    /// <summary>
    /// A stable, body-free refusal. The offending argument is never echoed, so
    /// output cannot be used to reflect caller-controlled text.
    /// </summary>
    private static int RefuseUnknownCommand()
    {
        Write(new CanonicalObject()
            .Set("code", ProtocolNames.Of(RefusalCode.UnknownCommand))
            .Set("component", ComponentIdentity.ComponentName)
            .Set("schemaVersion", ProtocolContract.SchemaVersion)
            .Set("status", "refused"));
        return UnknownCommandExitCode;
    }

    private static void Write(CanonicalObject value)
    {
        using System.IO.Stream output = Console.OpenStandardOutput();
        byte[] bytes = CanonicalJson.Serialize(value);
        output.Write(bytes, 0, bytes.Length);
        output.Write(Utf8.GetBytes("\n"), 0, 1);
        output.Flush();
    }
}

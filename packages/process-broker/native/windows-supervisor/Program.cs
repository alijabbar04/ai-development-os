using System;
using System.Collections.Generic;
using System.Text;

namespace AiDevOs.WindowsSupervisor;

/// <summary>
/// Entry point for a Windows production component candidate. The component's
/// own identity comes from <see cref="ComponentIdentity"/>.
///
/// Only two commands exist and both are read-only:
///
///   self-test        in-memory conformance over the parser, the state
///                    machine, canonical serialization, the recovery-record
///                    format, and manifest identity logic;
///   describe-artifact the component's own fixed identity.
///
/// There is no shell, no PATH lookup, no environment read, no current-directory
/// read, no DNS, no network, no registry access, no provider or credential
/// access, no plugin surface, no repository-workload surface, no runtime
/// download, no install or registration step, and no embedded secret or signing
/// key. Both commands are structurally incapable of creating an AppContainer
/// profile, a Job Object, a process, an ACL change, a registry value, a
/// recovery record, or any other persistent state: the only code that could do
/// so lives behind <see cref="MutationGate"/>, which is a compile-time false
/// constant, and no native implementation exists behind it.
/// </summary>
internal static class Program
{
    private const int SuccessExitCode = 0;
    private const int SelfTestFailedExitCode = 1;
    private const int UnknownCommandExitCode = 64;

    private static readonly UTF8Encoding Utf8 = new(encoderShouldEmitUTF8Identifier: false);

    internal static int Main(string[] args)
    {
        if (args is null || args.Length != 1)
        {
            return RefuseUnknownCommand();
        }

        return args[0] switch
        {
            "self-test" => RunSelfTest(),
            "describe-artifact" => DescribeArtifact(),
            _ => RefuseUnknownCommand(),
        };
    }

    private static int RunSelfTest()
    {
        ConformanceReport core = CoreConformance.Run();
        ConformanceReport role = RoleConformance.Run();
        bool passed = core.Passed && role.Passed;

        List<string> failed = [];
        failed.AddRange(core.FailedNames);
        failed.AddRange(role.FailedNames);
        failed.Sort(StringComparer.Ordinal);

        CanonicalObject result = new CanonicalObject()
            .Set("component", ComponentIdentity.ComponentName)
            .Set("coreConformanceDigest", core.Digest)
            .Set("coreVectorCount", core.Count)
            .Set("failedVectorCount", core.FailedCount + role.FailedCount)
            .Set("failedVectors", failed)
            .Set("hostStateCreated", false)
            .Set("manifestFixtureFingerprint", CoreConformance.ManifestFixtureFingerprint())
            .Set("mutatingOperationsPermitted", MutationGate.MutatingOperationsPermitted)
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
        CanonicalObject result = new CanonicalObject()
            .Set("architecture", ComponentIdentity.Architecture)
            .Set("buildRecipeVersion", ComponentIdentity.BuildRecipeVersion)
            .Set("component", ComponentIdentity.ComponentName)
            .Set("manifestKind", ArtifactManifest.ManifestKind)
            .Set("manifestSchemaVersion", ProtocolContract.SchemaVersion)
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

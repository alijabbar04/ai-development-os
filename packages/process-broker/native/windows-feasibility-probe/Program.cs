using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace AiDevOs.WindowsSandboxFeasibilityProbe;

internal static partial class Program
{
    private const int ProbeProtocolVersion = 4;
    private const int UnavailableExitCode = 2;
    private const int LifecycleProofFailedExitCode = 3;
    private const int ProcessProofFailedExitCode = 4;
    private const int BoundaryProofFailedExitCode = 5;
    private const int UsageExitCode = 64;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        WriteIndented = false,
    };

    public static int Main(string[] args)
    {
        try
        {
            if (args.Length == 1)
            {
                return args[0] switch
                {
                    "probe" => RunProbe(),
                    "self-test" => RunSelfTest(),
                    _ => RefuseUnknownCommand(),
                };
            }

            if (args.Length == 3 && args[0] == "profile-lifecycle-proof")
            {
                return RunProfileLifecycleProof(args[1], args[2]);
            }

            if (args.Length == 3 && args[0] == "synthetic-process-proof")
            {
                return RunSyntheticProcessProof(args[1], args[2]);
            }

            if (args.Length == 6 && args[0] == "structured-boundary-proof")
            {
                return RunStructuredBoundaryProof(
                    args[1],
                    args[2],
                    args[3],
                    args[4],
                    args[5]);
            }

            WriteStableError("invalid-command-shape");
            return UsageExitCode;
        }
        catch (Exception exception) when (!IsFatal(exception))
        {
            WriteStableError("command-failed");
            return UnavailableExitCode;
        }
    }

    private static int RunProbe()
    {
        ProbeResult result = WindowsFeasibilityProbe.Run();
        Console.Out.WriteLine(Serialize(result));
        return result.Status == "available" ? 0 : UnavailableExitCode;
    }

    private static int RunSelfTest()
    {
        ProbeResult first = WindowsFeasibilityProbe.Run();
        ProbeResult second = WindowsFeasibilityProbe.Run();
        string firstJson = Serialize(first);
        string secondJson = Serialize(second);
        string systemDirectory = Environment.GetFolderPath(Environment.SpecialFolder.System);
        bool bodyFree =
            !firstJson.Contains(systemDirectory, StringComparison.OrdinalIgnoreCase) &&
            !firstJson.Contains(Environment.UserName, StringComparison.OrdinalIgnoreCase);

        bool passed =
            firstJson == secondJson &&
            first.SchemaVersion == 1 &&
            first.ProtocolVersion == ProbeProtocolVersion &&
            first.Status == "unavailable" &&
            first.ProfileMutationAttempted is false &&
            first.ProcessCreationAttempted is false &&
            bodyFree &&
            (first.ProcessModel.Sha256 is null || Sha256Pattern().IsMatch(first.ProcessModel.Sha256));

        Console.Out.WriteLine(
            Serialize(
                new SelfTestResult(
                    SchemaVersion: 1,
                    ProtocolVersion: ProbeProtocolVersion,
                    Status: passed ? "passed" : "failed",
                    DeterministicOutput: firstJson == secondJson,
                    BodyFreeOutput: bodyFree,
                    ProfileMutationAttempted: false,
                    ProcessCreationAttempted: false)));
        return passed ? 0 : 1;
    }

    private static int RunProfileLifecycleProof(string profileName, string aclRoot)
    {
        ProfileLifecycleProofResult result = AppContainerProfileLifecycleProof.Run(
            profileName,
            aclRoot);
        Console.Out.WriteLine(Serialize(result));
        return result.Status == "passed" ? 0 : LifecycleProofFailedExitCode;
    }

    private static int RunSyntheticProcessProof(string profileName, string stagingRoot)
    {
        SyntheticProcessProofResult result = AppContainerSyntheticProcessProof.Run(
            profileName,
            stagingRoot);
        Console.Out.WriteLine(Serialize(result));
        return result.Status == "passed" ? 0 : ProcessProofFailedExitCode;
    }

    private static int RunStructuredBoundaryProof(
        string profileName,
        string stagingRoot,
        string canaryRoot,
        string fixtureSource,
        string expectedFixtureSha256)
    {
        StructuredBoundaryProofResult result = AppContainerSyntheticProcessProof.RunStructuredBoundary(
            profileName,
            stagingRoot,
            canaryRoot,
            fixtureSource,
            expectedFixtureSha256);
        Console.Out.WriteLine(Serialize(result));
        return result.Status == "passed" ? 0 : BoundaryProofFailedExitCode;
    }

    private static int RefuseUnknownCommand()
    {
        WriteStableError("unsupported-command");
        return UsageExitCode;
    }

    private static void WriteStableError(string code)
    {
        Console.Out.WriteLine(
            Serialize(
                new ErrorResult(
                    SchemaVersion: 1,
                    ProtocolVersion: ProbeProtocolVersion,
                    Status: "refused",
                    Code: code)));
    }

    private static string Serialize<T>(T value) => JsonSerializer.Serialize(value, JsonOptions);

    private static bool IsFatal(Exception exception) =>
        exception is OutOfMemoryException or StackOverflowException or AccessViolationException;

    [GeneratedRegex("^[a-f0-9]{64}$", RegexOptions.CultureInvariant)]
    private static partial Regex Sha256Pattern();
}

internal static class WindowsFeasibilityProbe
{
    private const int ProbeProtocolVersion = 4;
    private const uint LoadLibrarySearchSystem32 = 0x00000800;

    private static readonly string[] ProcessModelExports =
    [
        "Experimental_CreateProcessInSandbox",
        "Experimental_CreateProcessAsUserInSandbox",
    ];

    private static readonly string[] UserEnvironmentExports =
    [
        "CreateAppContainerProfile",
        "DeleteAppContainerProfile",
        "DeriveAppContainerSidFromAppContainerName",
        "GetAppContainerFolderPath",
    ];

    private static readonly string[] KernelExports =
    [
        "AssignProcessToJobObject",
        "CloseHandle",
        "CreateFileW",
        "CreateJobObjectW",
        "CreatePipe",
        "CreateProcessW",
        "DeleteProcThreadAttributeList",
        "GetExitCodeProcess",
        "GetCurrentProcess",
        "InitializeProcThreadAttributeList",
        "IsProcessInJob",
        "QueryInformationJobObject",
        "ReadFile",
        "ResumeThread",
        "SetHandleInformation",
        "SetInformationJobObject",
        "TerminateJobObject",
        "UpdateProcThreadAttribute",
    ];

    private static readonly string[] SecurityExports =
    [
        "CreateProcessAsUserW",
        "CreateRestrictedToken",
        "FreeSid",
        "GetTokenInformation",
        "OpenProcessToken",
    ];

    public static ProbeResult Run()
    {
        if (!OperatingSystem.IsWindows())
        {
            return UnsupportedPlatform();
        }

        LibraryProbe processModel = ProbeSystemLibrary("processmodel.dll", ProcessModelExports);
        LibraryProbe userEnvironment = ProbeSystemLibrary("userenv.dll", UserEnvironmentExports);
        LibraryProbe kernel = ProbeSystemLibrary("kernel32.dll", KernelExports);
        LibraryProbe security = ProbeSystemLibrary("advapi32.dll", SecurityExports);
        string processModelPath = ExactSystemLibraryPath("processmodel.dll");

        return new ProbeResult(
            SchemaVersion: 1,
            ProtocolVersion: ProbeProtocolVersion,
            Platform: "win32",
            Architecture: RuntimeInformation.ProcessArchitecture.ToString().ToLowerInvariant(),
            HostVersion: Environment.OSVersion.Version.ToString(),
            Status: "unavailable",
            Reason: "windows-native-process-composition-and-corpus-unverified",
            CurrentProcessInJob: QueryCurrentProcessJobMembership(),
            ProcessModel: CreateIdentity(processModelPath, processModel.Loaded),
            ExperimentalComposition: processModel,
            PublicComposition: new PublicCompositionProbe(
                UserEnvironment: userEnvironment,
                Kernel: kernel,
                Security: security),
            SandboxSpecification: new SandboxSpecificationProbe(
                RequiredVersion: "0.1.0",
                FileIdentifier: "SBOX",
                AuthoritativeSchemaBundled: false,
                SchemaLayoutVerified: false),
            ProfileMutationAttempted: false,
            ProcessCreationAttempted: false);
    }

    private static ProbeResult UnsupportedPlatform() =>
        new(
            SchemaVersion: 1,
            ProtocolVersion: ProbeProtocolVersion,
            Platform: RuntimeInformation.IsOSPlatform(OSPlatform.Windows) ? "win32" : "unsupported",
            Architecture: RuntimeInformation.ProcessArchitecture.ToString().ToLowerInvariant(),
            HostVersion: Environment.OSVersion.Version.ToString(),
            Status: "unavailable",
            Reason: "unsupported-platform",
            CurrentProcessInJob: null,
            ProcessModel: new SystemDllIdentity(false, null, null, null, null),
            ExperimentalComposition: LibraryProbe.Empty(ProcessModelExports),
            PublicComposition: new PublicCompositionProbe(
                UserEnvironment: LibraryProbe.Empty(UserEnvironmentExports),
                Kernel: LibraryProbe.Empty(KernelExports),
                Security: LibraryProbe.Empty(SecurityExports)),
            SandboxSpecification: new SandboxSpecificationProbe(
                RequiredVersion: "0.1.0",
                FileIdentifier: "SBOX",
                AuthoritativeSchemaBundled: false,
                SchemaLayoutVerified: false),
            ProfileMutationAttempted: false,
            ProcessCreationAttempted: false);

    private static bool? QueryCurrentProcessJobMembership()
    {
        return IsProcessInJob(GetCurrentProcess(), 0, out bool result) ? result : null;
    }

    private static string ExactSystemLibraryPath(string fileName)
    {
        string systemDirectory = Path.GetFullPath(
            Environment.GetFolderPath(Environment.SpecialFolder.System));
        string candidate = Path.GetFullPath(Path.Combine(systemDirectory, fileName));
        string? parent = Path.GetDirectoryName(candidate);
        if (!string.Equals(parent, systemDirectory, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("system-library-resolution-failed");
        }

        return candidate;
    }

    private static LibraryProbe ProbeSystemLibrary(
        string fileName,
        string[] exportNames)
    {
        string path = ExactSystemLibraryPath(fileName);
        nint handle = LoadLibraryExW(path, 0, LoadLibrarySearchSystem32);
        bool loaded = handle != 0;
        var exports = new List<ExportProbe>(exportNames.Length);

        try
        {
            foreach (string name in exportNames)
            {
                bool present = loaded && NativeLibrary.TryGetExport(handle, name, out _);
                exports.Add(new ExportProbe(Name: name, Present: present));
            }
        }
        finally
        {
            if (loaded)
            {
                _ = FreeLibrary(handle);
            }
        }

        return new LibraryProbe(Loaded: loaded, Exports: exports.ToArray());
    }

    private static SystemDllIdentity CreateIdentity(string path, bool loaded)
    {
        if (!loaded || !File.Exists(path))
        {
            return new SystemDllIdentity(false, null, null, null, null);
        }

        var file = new FileInfo(path);
        FileVersionInfo version = FileVersionInfo.GetVersionInfo(path);
        using FileStream stream = new(
            path,
            FileMode.Open,
            FileAccess.Read,
            FileShare.ReadWrite | FileShare.Delete,
            bufferSize: 128 * 1024,
            FileOptions.SequentialScan);
        string digest = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();

        return new SystemDllIdentity(
            Present: true,
            FileVersion: version.FileVersion,
            ProductVersion: version.ProductVersion,
            Length: file.Length,
            Sha256: digest);
    }

    [DllImport("kernel32.dll", EntryPoint = "GetCurrentProcess", ExactSpelling = true)]
    private static extern nint GetCurrentProcess();

    [DllImport(
        "kernel32.dll",
        EntryPoint = "LoadLibraryExW",
        ExactSpelling = true,
        CharSet = CharSet.Unicode,
        SetLastError = true)]
    private static extern nint LoadLibraryExW(string fileName, nint fileHandle, uint flags);

    [DllImport("kernel32.dll", EntryPoint = "FreeLibrary", ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool FreeLibrary(nint moduleHandle);

    [DllImport(
        "kernel32.dll",
        EntryPoint = "IsProcessInJob",
        ExactSpelling = true,
        SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsProcessInJob(
        nint processHandle,
        nint jobHandle,
        [MarshalAs(UnmanagedType.Bool)] out bool result);
}

internal sealed record ProbeResult(
    int SchemaVersion,
    int ProtocolVersion,
    string Platform,
    string Architecture,
    string HostVersion,
    string Status,
    string Reason,
    bool? CurrentProcessInJob,
    SystemDllIdentity ProcessModel,
    LibraryProbe ExperimentalComposition,
    PublicCompositionProbe PublicComposition,
    SandboxSpecificationProbe SandboxSpecification,
    bool ProfileMutationAttempted,
    bool ProcessCreationAttempted);

internal sealed record SystemDllIdentity(
    bool Present,
    string? FileVersion,
    string? ProductVersion,
    long? Length,
    string? Sha256);

internal sealed record ExportProbe(string Name, bool Present);

internal sealed record LibraryProbe(bool Loaded, IReadOnlyList<ExportProbe> Exports)
{
    public static LibraryProbe Empty(string[] names)
    {
        var exports = new ExportProbe[names.Length];
        for (int index = 0; index < names.Length; index++)
        {
            exports[index] = new ExportProbe(names[index], false);
        }

        return new LibraryProbe(false, exports);
    }
}

internal sealed record PublicCompositionProbe(
    LibraryProbe UserEnvironment,
    LibraryProbe Kernel,
    LibraryProbe Security);

internal sealed record SandboxSpecificationProbe(
    string RequiredVersion,
    string FileIdentifier,
    bool AuthoritativeSchemaBundled,
    bool SchemaLayoutVerified);

internal sealed record SelfTestResult(
    int SchemaVersion,
    int ProtocolVersion,
    string Status,
    bool DeterministicOutput,
    bool BodyFreeOutput,
    bool ProfileMutationAttempted,
    bool ProcessCreationAttempted);

internal sealed record ErrorResult(
    int SchemaVersion,
    int ProtocolVersion,
    string Status,
    string Code);

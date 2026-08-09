using System;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace AiDevOs.WindowsBoundaryFixture;

internal static class Program
{
    private const string AllowedContent = "stage17-boundary-allowed-v1";
    private const string ChildContent = "stage17-boundary-child-ran-v1";
    private const uint CreateBreakawayFromJob = 0x01000000;
    private const uint CreateNoWindow = 0x08000000;
    private const uint WaitObject0 = 0;
    private const uint WaitTimeout = 258;
    private const uint ChildWaitMilliseconds = 2_000;
    private const int MinimumLifecycleHoldMilliseconds = 1_000;
    private const int MaximumLifecycleHoldMilliseconds = 10_000;
    private const int ErrorAccessDenied = 5;
    private const int ErrorNotEnoughQuota = 1_816;
    private static string CurrentStep = "dispatch";

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
            if (args.Length == 2 && args[0] == "child")
            {
                return RunChild(args[1]);
            }

            if (args.Length == 2 && args[0] == "child-positive-control")
            {
                return RunChildPositiveControl(args[1]);
            }

            if (args.Length == 6 && args[0] == "probe")
            {
                return RunBoundaryProbe(args[1], args[2], args[3], args[4], args[5]);
            }

            if (args.Length == 3 && args[0] == "lifecycle-hold")
            {
                return RunLifecycleHold(args[1], args[2]);
            }

            if (args.Length == 2 && args[0] == "ordinary-control")
            {
                return RunOrdinaryControl(args[1]);
            }

            Write(new FixtureError(1, "refused", "invalid-command-shape"));
            return 64;
        }
        catch (Exception exception) when (!IsFatal(exception))
        {
            Write(new FixtureError(1, "failed", $"fixture-{CurrentStep}-failed"));
            return 1;
        }
    }

    private static int RunChild(string markerPath)
    {
        string canonicalMarker = ValidateMarkerPath(markerPath);
        File.WriteAllText(canonicalMarker, ChildContent);
        return 0;
    }

    private static int RunChildPositiveControl(string markerPath)
    {
        string canonicalMarker = Path.GetFullPath(markerPath);
        string? parent = Path.GetDirectoryName(canonicalMarker);
        if (parent is null || !Directory.Exists(parent) || File.Exists(canonicalMarker))
        {
            Write(new ChildPositiveControlResult(1, "failed", false, false, true, null));
            return 1;
        }

        ChildAttempt attempt = AttemptChild(canonicalMarker, breakaway: false);
        bool markerObserved = attempt.MarkerObserved;
        if (File.Exists(canonicalMarker))
        {
            File.Delete(canonicalMarker);
        }

        bool markerRemoved = !File.Exists(canonicalMarker);
        bool passed = attempt.CreateReturnedSuccess && markerObserved && markerRemoved;
        Write(
            new ChildPositiveControlResult(
                SchemaVersion: 1,
                Status: passed ? "passed" : "failed",
                CreateReturnedSuccess: attempt.CreateReturnedSuccess,
                ChildMarkerObserved: markerObserved,
                ChildMarkerRemoved: markerRemoved,
                NativeErrorCode: attempt.NativeErrorCode));
        return passed ? 0 : 1;
    }

    private static int RunLifecycleHold(string markerPath, string holdMillisecondsText)
    {
        CurrentStep = "lifecycle-validate";
        string canonicalMarker = ValidateMarkerPath(markerPath);
        int holdMilliseconds = ParseBoundedInt(
            holdMillisecondsText,
            MinimumLifecycleHoldMilliseconds,
            MaximumLifecycleHoldMilliseconds);
        CurrentStep = "lifecycle-marker";
        File.WriteAllText(canonicalMarker, "stage17-helper-lifecycle-ready-v1");
        CurrentStep = "lifecycle-ready";
        Write(new LifecycleReadyResult(1, "ready", "lifecycle-ready"));
        Console.Out.Flush();
        CurrentStep = "lifecycle-hold";
        System.Threading.Thread.Sleep(holdMilliseconds);
        return 0;
    }

    private static int RunOrdinaryControl(string markerPath)
    {
        string canonical = Path.GetFullPath(markerPath);
        string temp = Path.TrimEndingDirectorySeparator(Path.GetFullPath(Path.GetTempPath()));
        string name = Path.GetFileName(canonical);
        const string prefix = "stage17-runtime-control-";
        const string suffix = ".marker";
        bool valid =
            string.Equals(Path.GetDirectoryName(canonical), temp, StringComparison.OrdinalIgnoreCase) &&
            name.StartsWith(prefix, StringComparison.Ordinal) &&
            name.EndsWith(suffix, StringComparison.Ordinal) &&
            name.Length == prefix.Length + 32 + 2 + suffix.Length &&
            IsLowerHex(name.Substring(prefix.Length, 32)) &&
            name[prefix.Length + 32] == '-' &&
            name[prefix.Length + 33] is '1' or '2' &&
            !File.Exists(canonical);
        if (!valid)
        {
            Write(new FixtureError(1, "refused", "ordinary-control-path-invalid"));
            return 64;
        }

        File.WriteAllText(canonical, "stage17-ordinary-control-v1");
        return 0;
    }

    private static int RunBoundaryProbe(
        string allowedPath,
        string canaryPath,
        string stagingWritePath,
        string loopbackPortText,
        string childAttemptsText)
    {
        CurrentStep = "validate-input";
        string canonicalAllowed = Path.GetFullPath(allowedPath);
        string canonicalCanary = Path.GetFullPath(canaryPath);
        string canonicalStagingWrite = Path.GetFullPath(stagingWritePath);
        int loopbackPort = ParseBoundedInt(loopbackPortText, 1, ushort.MaxValue);
        int childAttempts = ParseBoundedInt(childAttemptsText, 1, 16);

        CurrentStep = "allowed-read";
        bool allowedReadSucceeded = false;
        bool allowedContentMatched = false;
        try
        {
            string content = File.ReadAllText(canonicalAllowed);
            allowedReadSucceeded = true;
            allowedContentMatched = string.Equals(
                content,
                AllowedContent,
                StringComparison.Ordinal);
        }
        catch (Exception exception) when (!IsFatal(exception))
        {
            allowedReadSucceeded = false;
        }

        CurrentStep = "filesystem-denials";
        bool stagingWriteDenied = IsFileAccessDenied(
            () => File.WriteAllText(canonicalStagingWrite, "unexpected-stage-write"));
        bool canaryReadDenied = IsFileAccessDenied(
            () => _ = File.ReadAllText(canonicalCanary));
        bool canaryWriteDenied = IsFileAccessDenied(
            () => File.AppendAllText(canonicalCanary, "unexpected-canary-write"));

        CurrentStep = "loopback-connect";
        SocketAttempt loopbackConnect = AttemptSocket(
            () =>
            {
                using var socket = new Socket(
                    AddressFamily.InterNetwork,
                    SocketType.Stream,
                    ProtocolType.Tcp);
                socket.Connect(new IPEndPoint(IPAddress.Loopback, loopbackPort));
            });
        CurrentStep = "loopback-listen";
        SocketAttempt loopbackListen = AttemptSocket(
            () =>
            {
                using var socket = new Socket(
                    AddressFamily.InterNetwork,
                    SocketType.Stream,
                    ProtocolType.Tcp);
                socket.ExclusiveAddressUse = true;
                socket.Bind(new IPEndPoint(IPAddress.Loopback, 0));
                socket.Listen(1);
            });
        CurrentStep = "loopback-udp";
        SocketAttempt loopbackUdpSend = AttemptSocket(
            () =>
            {
                using var socket = new Socket(
                    AddressFamily.InterNetwork,
                    SocketType.Dgram,
                    ProtocolType.Udp);
                _ = socket.SendTo(
                    [0x53, 0x31, 0x37],
                    new IPEndPoint(IPAddress.Loopback, loopbackPort));
            });

        CurrentStep = "child-attempts";
        int normalNativeDenied = 0;
        int normalTerminatedBeforeMarker = 0;
        int normalMarkerObserved = 0;
        int normalUnexpected = 0;
        int breakawayNativeDenied = 0;
        int breakawayTerminatedBeforeMarker = 0;
        int breakawayMarkerObserved = 0;
        int breakawayUnexpected = 0;
        string fixtureTemp = ValidateFixtureTemp();

        for (int index = 0; index < childAttempts; index++)
        {
            string normalMarker = Path.Combine(
                fixtureTemp,
                $"stage17-boundary-normal-{index.ToString(CultureInfo.InvariantCulture)}.marker");
            ClassifyChildAttempt(
                AttemptChild(normalMarker, breakaway: false),
                ref normalNativeDenied,
                ref normalTerminatedBeforeMarker,
                ref normalMarkerObserved,
                ref normalUnexpected);

            string breakawayMarker = Path.Combine(
                fixtureTemp,
                $"stage17-boundary-breakaway-{index.ToString(CultureInfo.InvariantCulture)}.marker");
            ClassifyChildAttempt(
                AttemptChild(breakawayMarker, breakaway: true),
                ref breakawayNativeDenied,
                ref breakawayTerminatedBeforeMarker,
                ref breakawayMarkerObserved,
                ref breakawayUnexpected);
        }

        bool normalChildrenBlocked =
            normalNativeDenied + normalTerminatedBeforeMarker == childAttempts &&
            normalMarkerObserved == 0 &&
            normalUnexpected == 0;
        bool breakawayChildrenBlocked =
            breakawayNativeDenied + breakawayTerminatedBeforeMarker == childAttempts &&
            breakawayMarkerObserved == 0 &&
            breakawayUnexpected == 0;
        bool passed =
            allowedReadSucceeded &&
            allowedContentMatched &&
            stagingWriteDenied &&
            canaryReadDenied &&
            canaryWriteDenied &&
            loopbackConnect.Denied &&
            normalChildrenBlocked &&
            breakawayChildrenBlocked;

        CurrentStep = "serialize-result";
        Write(
            new BoundaryFixtureResult(
                SchemaVersion: 1,
                Status: passed ? "passed" : "failed",
                AllowedReadSucceeded: allowedReadSucceeded,
                AllowedContentMatched: allowedContentMatched,
                StagingWriteDenied: stagingWriteDenied,
                CanaryReadDenied: canaryReadDenied,
                CanaryWriteDenied: canaryWriteDenied,
                LoopbackConnectDenied: loopbackConnect.Denied,
                LoopbackConnectNativeErrorCode: loopbackConnect.NativeErrorCode,
                LoopbackListenDenied: loopbackListen.Denied,
                LoopbackListenNativeErrorCode: loopbackListen.NativeErrorCode,
                LoopbackUdpSendDenied: loopbackUdpSend.Denied,
                LoopbackUdpSendNativeErrorCode: loopbackUdpSend.NativeErrorCode,
                ChildAttemptsPerMode: childAttempts,
                NormalChildNativeDenied: normalNativeDenied,
                NormalChildTerminatedBeforeMarker: normalTerminatedBeforeMarker,
                NormalChildMarkerObserved: normalMarkerObserved,
                NormalChildUnexpected: normalUnexpected,
                BreakawayChildNativeDenied: breakawayNativeDenied,
                BreakawayChildTerminatedBeforeMarker: breakawayTerminatedBeforeMarker,
                BreakawayChildMarkerObserved: breakawayMarkerObserved,
                BreakawayChildUnexpected: breakawayUnexpected,
                NormalChildrenBlocked: normalChildrenBlocked,
                BreakawayChildrenBlocked: breakawayChildrenBlocked));
        return passed ? 0 : 1;
    }

    private static void ClassifyChildAttempt(
        ChildAttempt attempt,
        ref int nativeDenied,
        ref int terminatedBeforeMarker,
        ref int markerObserved,
        ref int unexpected)
    {
        if (attempt.MarkerObserved)
        {
            markerObserved++;
        }
        else if (
            !attempt.CreateReturnedSuccess &&
            attempt.NativeErrorCode is ErrorAccessDenied or ErrorNotEnoughQuota)
        {
            nativeDenied++;
        }
        else if (attempt.CreateReturnedSuccess && attempt.Exited)
        {
            terminatedBeforeMarker++;
        }
        else
        {
            unexpected++;
        }
    }

    private static ChildAttempt AttemptChild(string markerPath, bool breakaway)
    {
        string canonicalMarker = Path.GetFullPath(markerPath);
        if (File.Exists(canonicalMarker))
        {
            File.Delete(canonicalMarker);
        }

        string executable = Environment.ProcessPath ??
            throw new InvalidOperationException("process-path-unavailable");
        char[] commandLine =
            ($"{QuoteArgument(executable)} child {QuoteArgument(canonicalMarker)}\0").ToCharArray();
        var startupInfo = new StartupInfo
        {
            Size = checked((uint)Marshal.SizeOf<StartupInfo>()),
        };
        uint flags = CreateNoWindow | (breakaway ? CreateBreakawayFromJob : 0);
        bool created = CreateProcessW(
            executable,
            commandLine,
            0,
            0,
            inheritHandles: false,
            flags,
            0,
            Environment.CurrentDirectory,
            ref startupInfo,
            out ProcessInformation processInformation);
        if (!created)
        {
            return new ChildAttempt(false, false, false, Marshal.GetLastWin32Error());
        }

        bool exited = false;
        try
        {
            uint wait = WaitForSingleObject(
                processInformation.Process,
                ChildWaitMilliseconds);
            exited = wait == WaitObject0;
            if (wait == WaitTimeout)
            {
                _ = TerminateProcess(processInformation.Process, 1);
                exited = WaitForSingleObject(
                    processInformation.Process,
                    ChildWaitMilliseconds) == WaitObject0;
            }
        }
        finally
        {
            _ = CloseHandle(processInformation.Thread);
            _ = CloseHandle(processInformation.Process);
        }

        return new ChildAttempt(true, exited, File.Exists(canonicalMarker), null);
    }

    private static string ValidateMarkerPath(string markerPath)
    {
        string canonical = Path.GetFullPath(markerPath);
        string fileName = Path.GetFileName(canonical);
        bool validBoundaryMarker =
            fileName.StartsWith("stage17-boundary-", StringComparison.Ordinal) &&
            string.Equals(
                Path.GetDirectoryName(canonical),
                ValidateFixtureTemp(),
                StringComparison.OrdinalIgnoreCase) &&
            string.Equals(Path.GetExtension(canonical), ".marker", StringComparison.Ordinal);
        bool validLifecycleMarker = ValidateLifecycleMarkerFromExecutable(
            canonical,
            fileName);
        if (!validBoundaryMarker && !validLifecycleMarker)
        {
            throw new ArgumentException("invalid-child-marker-path", nameof(markerPath));
        }

        return canonical;
    }

    private static bool ValidateLifecycleMarkerFromExecutable(
        string canonicalMarker,
        string markerFileName)
    {
        const string fixturePrefix = "stage17-helper-fixture-";
        const string fixtureSuffix = ".exe";
        const string markerPrefix = "stage17-helper-lifecycle-";
        const string markerSuffix = ".marker";
        string executable = Path.GetFullPath(
            Environment.ProcessPath ?? string.Empty);
        string executableFileName = Path.GetFileName(executable);
        int expectedFixtureLength = checked(
            fixturePrefix.Length + 32 + fixtureSuffix.Length);
        if (
            executableFileName.Length != expectedFixtureLength ||
            !executableFileName.StartsWith(fixturePrefix, StringComparison.Ordinal) ||
            !executableFileName.EndsWith(fixtureSuffix, StringComparison.Ordinal))
        {
            return false;
        }

        string token = executableFileName.Substring(fixturePrefix.Length, 32);
        if (!IsLowerHex(token))
        {
            return false;
        }

        string? stagingRoot = Path.GetDirectoryName(executable);
        if (stagingRoot is null)
        {
            return false;
        }

        string expectedMarkerRoot = Path.GetFullPath(
            Path.Combine(stagingRoot, "marker"));
        return
            string.Equals(
                Path.GetDirectoryName(canonicalMarker),
                expectedMarkerRoot,
                StringComparison.OrdinalIgnoreCase) &&
            string.Equals(
                markerFileName,
                $"{markerPrefix}{token}{markerSuffix}",
                StringComparison.Ordinal);
    }

    private static bool IsLowerHex(string value)
    {
        foreach (char character in value)
        {
            if (character is not (>= '0' and <= '9') and not (>= 'a' and <= 'f'))
            {
                return false;
            }
        }

        return value.Length > 0;
    }

    private static string ValidateFixtureTemp()
    {
        string? temp = Environment.GetEnvironmentVariable("TEMP");
        if (string.IsNullOrWhiteSpace(temp))
        {
            throw new InvalidOperationException("fixture-temp-unavailable");
        }

        return Path.TrimEndingDirectorySeparator(Path.GetFullPath(temp));
    }

    private static int ParseBoundedInt(string text, int minimum, int maximum)
    {
        if (
            !int.TryParse(
                text,
                NumberStyles.None,
                CultureInfo.InvariantCulture,
                out int value) ||
            value < minimum ||
            value > maximum)
        {
            throw new ArgumentException("invalid-bounded-integer", nameof(text));
        }

        return value;
    }

    private static bool IsFileAccessDenied(Action action)
    {
        try
        {
            action();
            return false;
        }
        catch (UnauthorizedAccessException)
        {
            return true;
        }
        catch (IOException exception) when ((exception.HResult & 0xFFFF) == ErrorAccessDenied)
        {
            return true;
        }
    }

    private static SocketAttempt AttemptSocket(Action action)
    {
        try
        {
            action();
            return new SocketAttempt(Denied: false, NativeErrorCode: null);
        }
        catch (SocketException exception)
        {
            return new SocketAttempt(Denied: true, NativeErrorCode: exception.NativeErrorCode);
        }
    }

    private static string QuoteArgument(string value)
    {
        if (value.Length == 0)
        {
            return "\"\"";
        }

        var output = new System.Text.StringBuilder(value.Length + 2);
        output.Append('"');
        int backslashes = 0;
        foreach (char character in value)
        {
            if (character == '\\')
            {
                backslashes++;
            }
            else if (character == '"')
            {
                output.Append('\\', checked((backslashes * 2) + 1));
                output.Append('"');
                backslashes = 0;
            }
            else
            {
                output.Append('\\', backslashes);
                output.Append(character);
                backslashes = 0;
            }
        }

        output.Append('\\', checked(backslashes * 2));
        output.Append('"');
        return output.ToString();
    }

    private static void Write<T>(T result) =>
        Console.Out.WriteLine(JsonSerializer.Serialize(result, JsonOptions));

    private static bool IsFatal(Exception exception) =>
        exception is OutOfMemoryException or StackOverflowException or AccessViolationException;

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfo
    {
        internal uint Size;
        internal nint Reserved;
        internal nint Desktop;
        internal nint Title;
        internal uint X;
        internal uint Y;
        internal uint XSize;
        internal uint YSize;
        internal uint XCountChars;
        internal uint YCountChars;
        internal uint FillAttribute;
        internal uint Flags;
        internal ushort ShowWindow;
        internal ushort Reserved2Count;
        internal nint Reserved2;
        internal nint StandardInput;
        internal nint StandardOutput;
        internal nint StandardError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        internal nint Process;
        internal nint Thread;
        internal uint ProcessId;
        internal uint ThreadId;
    }

    [DllImport(
        "kernel32.dll",
        EntryPoint = "CreateProcessW",
        ExactSpelling = true,
        CharSet = CharSet.Unicode,
        SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcessW(
        string applicationName,
        [In, Out] char[] commandLine,
        nint processAttributes,
        nint threadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
        uint creationFlags,
        nint environment,
        string currentDirectory,
        ref StartupInfo startupInfo,
        out ProcessInformation processInformation);

    [DllImport(
        "kernel32.dll",
        EntryPoint = "WaitForSingleObject",
        ExactSpelling = true,
        SetLastError = true)]
    private static extern uint WaitForSingleObject(nint handle, uint milliseconds);

    [DllImport(
        "kernel32.dll",
        EntryPoint = "TerminateProcess",
        ExactSpelling = true,
        SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateProcess(nint processHandle, uint exitCode);

    [DllImport("kernel32.dll", EntryPoint = "CloseHandle", ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(nint handle);
}

internal sealed record FixtureError(int SchemaVersion, string Status, string Code);

internal sealed record LifecycleReadyResult(int SchemaVersion, string Status, string Code);

internal sealed record ChildPositiveControlResult(
    int SchemaVersion,
    string Status,
    bool CreateReturnedSuccess,
    bool ChildMarkerObserved,
    bool ChildMarkerRemoved,
    int? NativeErrorCode);

internal sealed record BoundaryFixtureResult(
    int SchemaVersion,
    string Status,
    bool AllowedReadSucceeded,
    bool AllowedContentMatched,
    bool StagingWriteDenied,
    bool CanaryReadDenied,
    bool CanaryWriteDenied,
    bool LoopbackConnectDenied,
    int? LoopbackConnectNativeErrorCode,
    bool LoopbackListenDenied,
    int? LoopbackListenNativeErrorCode,
    bool LoopbackUdpSendDenied,
    int? LoopbackUdpSendNativeErrorCode,
    int ChildAttemptsPerMode,
    int NormalChildNativeDenied,
    int NormalChildTerminatedBeforeMarker,
    int NormalChildMarkerObserved,
    int NormalChildUnexpected,
    int BreakawayChildNativeDenied,
    int BreakawayChildTerminatedBeforeMarker,
    int BreakawayChildMarkerObserved,
    int BreakawayChildUnexpected,
    bool NormalChildrenBlocked,
    bool BreakawayChildrenBlocked);

internal sealed record ChildAttempt(
    bool CreateReturnedSuccess,
    bool Exited,
    bool MarkerObserved,
    int? NativeErrorCode);

internal sealed record SocketAttempt(bool Denied, int? NativeErrorCode);

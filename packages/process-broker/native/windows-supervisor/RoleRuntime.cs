using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using AiDevOs.WindowsRuntime;
using Microsoft.Win32;

[assembly: DefaultDllImportSearchPaths(DllImportSearchPath.System32)]

namespace AiDevOs.WindowsSupervisor;

/// <summary>
/// The supervisor's sealed operational lifecycle. It owns the private Job and
/// exact helper handle, proxies one strict framed session, and performs only
/// token-derived non-recursive recovery. Fault timing remains a proof-controller
/// concern; cancellation and recovery are ordinary production operations.
/// </summary>
internal static class RoleRuntime
{
    private const string SupervisorImageName = "AI.DevOS.WindowsSupervisor.exe";
    private const string HelperImageName = "AI.DevOS.WindowsHelper.exe";
    private const string HelperPayloadName = "AI.DevOS.WindowsHelper.dll";
    private const string TargetImageName = "AI.DevOS.WindowsBoundaryFixture.exe";
    private const int ProtocolVersion = 5;
    private const int MaximumFrameBytes = 4_096;
    private const int FrameTimeoutMilliseconds = 30_000;
    private const uint HelperWaitMilliseconds = 45_000;
    private const uint WaitObject0 = 0;
    private const uint CreateUnicodeEnvironment = 0x00000400;
    private const uint ExtendedStartupInfoPresent = 0x00080000;
    private const uint CreateNoWindow = 0x08000000;
    private const uint StartfUseStdHandles = 0x00000100;
    private const uint HandleFlagInherit = 0x00000001;
    private const uint GenericRead = 0x80000000;
    private const uint GenericWrite = 0x40000000;
    private const uint FileShareRead = 0x00000001;
    private const uint FileShareWrite = 0x00000002;
    private const uint OpenExisting = 3;
    private const nuint ProcThreadAttributeHandleList = 0x00020002;
    private const uint JobObjectLimitProcessTime = 0x00000002;
    private const uint JobObjectLimitJobTime = 0x00000004;
    private const uint JobObjectLimitActiveProcess = 0x00000008;
    private const uint JobObjectLimitProcessMemory = 0x00000100;
    private const uint JobObjectLimitJobMemory = 0x00000200;
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private const int JobObjectExtendedLimitInformationClass = 9;
    private const int ErrorBrokenPipe = 109;
    private const int ErrorNoData = 232;
    private const uint InjectedCancellationExitCode = 17;
    private const string AnthropicEgressEndpoint = "https://api.anthropic.com/v1/models";
    private const string OpenAiEgressEndpoint = "https://api.openai.com/v1/models";

    private static readonly string[] Scenarios =
    [
        "normal-lifecycle",
        "control-disconnect-before-target",
        "helper-terminated-after-setup",
        "helper-terminated-target-suspended",
        "supervisor-terminated-target-suspended",
        "supervisor-terminated-target-running",
        "supervisor-helper-terminated-target-running",
        "supervisor-terminated-after-target-exit",
    ];

    internal static bool TryDispatch(string[] args, out int exitCode)
    {
        exitCode = 64;
        if (string.Equals(args[0], "run-session", StringComparison.Ordinal))
        {
            if (args.Length != 3)
            {
                return true;
            }

            exitCode = RunSession(args[1], args[2]);
            return true;
        }

        if (string.Equals(args[0], "recover", StringComparison.Ordinal))
        {
            if (args.Length != 2)
            {
                return true;
            }

            exitCode = RunRecovery(args[1]);
            return true;
        }

        if (string.Equals(args[0], "egress-relay", StringComparison.Ordinal))
        {
            if (args.Length != 3)
            {
                return true;
            }

            exitCode = RunEgressRelay(args[1], args[2]);
            return true;
        }

        return false;
    }

    internal static bool RunReadOnlySelfTest()
    {
        const string runToken = "0123456789abcdef0123456789abcdef";
        string scenarioToken = RuntimeClosureLease.DeriveScenarioToken(runToken, 0);
        string digest = new('a', 64);
        byte[] request = JsonSerializer.SerializeToUtf8Bytes(new
        {
            schemaVersion = 1,
            protocolVersion = ProtocolVersion,
            command = "run-lifecycle-scenario",
            scenario = Scenarios[0],
            token = scenarioToken,
            helperSha256 = digest,
            helperPayloadSha256 = digest,
            fixtureSha256 = digest,
        });
        byte[] control = JsonSerializer.SerializeToUtf8Bytes(new
        {
            schemaVersion = 1,
            protocolVersion = ProtocolVersion,
            command = "continue",
            phase = "setup-complete",
        });
        byte[] mismatchedScenario = JsonSerializer.SerializeToUtf8Bytes(new
        {
            schemaVersion = 1,
            protocolVersion = ProtocolVersion,
            command = "run-lifecycle-scenario",
            scenario = Scenarios[1],
            token = scenarioToken,
            helperSha256 = digest,
            helperPayloadSha256 = digest,
            fixtureSha256 = digest,
        });
        return RuntimeClosureLease.RunReadOnlySelfTest() &&
            TryParseRequest(request, runToken, digest, digest, digest, out _, out _) &&
            !TryParseRequest(
                mismatchedScenario,
                runToken,
                digest,
                digest,
                digest,
                out _,
                out _) &&
            TryParseControl(control, "setup-complete", out string action) &&
            string.Equals(action, "continue", StringComparison.Ordinal) &&
            TryParseEgressProvider(JsonSerializer.SerializeToUtf8Bytes(new
            {
                schemaVersion = 1,
                protocolVersion = ProtocolVersion,
                command = "provider-egress-canary",
                provider = "anthropic",
            }), out string provider) &&
            string.Equals(provider, "anthropic", StringComparison.Ordinal) &&
            IsPublicAddress(IPAddress.Parse("93.184.216.34")) &&
            IsPublicAddress(IPAddress.Parse("2606:4700:4700::1111")) &&
            !IsPublicAddress(IPAddress.Parse("10.0.0.1")) &&
            !IsPublicAddress(IPAddress.Parse("100.64.0.1")) &&
            !IsPublicAddress(IPAddress.Parse("192.0.2.1")) &&
            !IsPublicAddress(IPAddress.Parse("198.18.0.1")) &&
            !IsPublicAddress(IPAddress.Parse("203.0.113.1")) &&
            !IsPublicAddress(IPAddress.Parse("::")) &&
            !IsPublicAddress(IPAddress.Parse("2001:db8::1")) &&
            !IsPublicAddress(IPAddress.Parse("fc00::1")) &&
            IsRunToken(runToken) &&
            !IsRunToken(runToken.ToUpperInvariant());
    }

    private static int RunSession(string requestReadText, string responseWriteText)
    {
        nint requestRead = 0;
        nint responseWrite = 0;
        try
        {
            requestRead = ParseHandle(requestReadText);
            responseWrite = ParseHandle(responseWriteText);
            if (requestRead == responseWrite)
            {
                return 70;
            }

            using RuntimeClosureLease closure =
                RuntimeClosureLease.AcquireFromCurrentImage(SupervisorImageName);
            byte[] initial = ReadFrame(requestRead, FrameTimeoutMilliseconds);
            if (!TryParseRequest(
                    initial,
                    closure.RunToken,
                    closure.DigestOf(HelperImageName),
                    closure.DigestOf(HelperPayloadName),
                    closure.DigestOf(TargetImageName),
                    out string token,
                    out _))
            {
                WriteStableRefusal(responseWrite, "invalid-session-request");
                return 65;
            }

            using var session = new SupervisorSession(closure, token);
            return session.Proxy(requestRead, responseWrite, initial);
        }
        catch (ChannelClosedException)
        {
            return 7;
        }
        catch (Exception exception) when (!IsFatal(exception))
        {
            TryWriteStableRefusal(responseWrite, "supervisor-session-failed");
            return 70;
        }
        finally
        {
            CloseNativeHandle(ref requestRead);
            CloseNativeHandle(ref responseWrite);
        }
    }

    private static int RunRecovery(string token)
    {
        bool recovered = false;
        try
        {
            if (IsRunToken(token))
            {
                using RuntimeClosureLease closure =
                    RuntimeClosureLease.AcquireFromCurrentImage(SupervisorImageName);
                closure.AssertOpen();
                recovered = IsAuthorizedScenarioToken(closure.RunToken, token) &&
                    RecoverExact(token);
            }
        }
        catch (Exception exception) when (!IsFatal(exception))
        {
            recovered = false;
        }

        WriteConsole(new CanonicalObject()
            .Set("cleanupConfirmed", recovered)
            .Set("component", ComponentIdentity.ComponentName)
            .Set("schemaVersion", 1)
            .Set("status", recovered ? "recovered" : "refused"));
        return recovered ? 0 : 2;
    }

    private static int RunEgressRelay(string requestReadText, string responseWriteText)
    {
        nint requestRead = 0;
        nint responseWrite = 0;
        try
        {
            requestRead = ParseHandle(requestReadText);
            responseWrite = ParseHandle(responseWriteText);
            if (requestRead == responseWrite)
            {
                return 70;
            }

            using RuntimeClosureLease closure =
                RuntimeClosureLease.AcquireFromCurrentImage(SupervisorImageName);
            closure.AssertOpen();
            byte[] request = ReadFrame(requestRead, FrameTimeoutMilliseconds);
            if (!TryParseEgressProvider(request, out string provider))
            {
                WriteStableRefusal(responseWrite, "egress-request-refused");
                return 65;
            }

            EgressCanaryOutcome outcome = RunEgressCanary(provider);
            WriteFrame(responseWrite, JsonSerializer.SerializeToUtf8Bytes(new
            {
                schemaVersion = 1,
                protocolVersion = ProtocolVersion,
                status = outcome.Passed ? "passed" : "failed",
                code = outcome.Code,
                provider,
                endpointFingerprint = outcome.EndpointFingerprint,
                redirectObserved = outcome.RedirectObserved,
                proxyEnabled = false,
                quicEnabled = false,
                credentialsUsed = false,
                requestBodyBytes = 0,
            }));
            return outcome.Passed ? 0 : 70;
        }
        catch (Exception exception) when (!IsFatal(exception))
        {
            TryWriteStableRefusal(responseWrite, "egress-relay-failed");
            return 70;
        }
        finally
        {
            CloseNativeHandle(ref requestRead);
            CloseNativeHandle(ref responseWrite);
        }
    }

    private static bool TryParseEgressProvider(ReadOnlySpan<byte> payload, out string provider)
    {
        provider = string.Empty;
        try
        {
            using JsonDocument document = JsonDocument.Parse(payload.ToArray());
            JsonElement root = document.RootElement;
            if (!HasShape(root, ["schemaVersion", "protocolVersion", "command", "provider"]) ||
                root.GetProperty("schemaVersion").GetInt32() != 1 ||
                root.GetProperty("protocolVersion").GetInt32() != ProtocolVersion ||
                !string.Equals(
                    root.GetProperty("command").GetString(),
                    "provider-egress-canary",
                    StringComparison.Ordinal))
            {
                return false;
            }

            provider = root.GetProperty("provider").GetString() ?? string.Empty;
            return provider is "anthropic" or "openai";
        }
        catch (Exception exception) when (!IsFatal(exception))
        {
            return false;
        }
    }

    private static EgressCanaryOutcome RunEgressCanary(string provider)
    {
        Uri endpoint = provider switch
        {
            "anthropic" => new Uri(AnthropicEgressEndpoint, UriKind.Absolute),
            "openai" => new Uri(OpenAiEgressEndpoint, UriKind.Absolute),
            _ => throw new NativeRuntimeException("egress-provider-unreviewed"),
        };
        string endpointFingerprint = Convert.ToHexString(
            SHA256.HashData(Encoding.UTF8.GetBytes(endpoint.AbsoluteUri)))
            .ToLowerInvariant();

        using var handler = new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            UseProxy = false,
            ConnectTimeout = TimeSpan.FromSeconds(10),
            AutomaticDecompression = DecompressionMethods.None,
            UseCookies = false,
            Credentials = null,
            PreAuthenticate = false,
        };
        handler.ConnectCallback = async (context, cancellationToken) =>
        {
            if (!string.Equals(
                    context.DnsEndPoint.Host,
                    endpoint.DnsSafeHost,
                    StringComparison.Ordinal) ||
                context.DnsEndPoint.Port != 443)
            {
                throw new HttpRequestException("egress-connect-destination-refused");
            }

            IPAddress[] addresses = await Dns.GetHostAddressesAsync(
                endpoint.DnsSafeHost,
                cancellationToken).ConfigureAwait(false);
            Array.Sort(addresses, static (left, right) =>
                string.CompareOrdinal(left.ToString(), right.ToString()));
            if (addresses.Length == 0 || Array.Exists(addresses, static address => !IsPublicAddress(address)))
            {
                throw new HttpRequestException("egress-dns-answer-refused");
            }

            foreach (IPAddress address in addresses)
            {
                var socket = new Socket(address.AddressFamily, SocketType.Stream, ProtocolType.Tcp)
                {
                    NoDelay = true,
                };
                try
                {
                    await socket.ConnectAsync(
                        new IPEndPoint(address, 443),
                        cancellationToken).ConfigureAwait(false);
                    return new NetworkStream(socket, ownsSocket: true);
                }
                catch (Exception exception) when (!IsFatal(exception))
                {
                    socket.Dispose();
                }
            }

            throw new HttpRequestException("egress-public-address-unreachable");
        };

        using var client = new HttpClient(handler)
        {
            Timeout = TimeSpan.FromSeconds(15),
            DefaultRequestVersion = HttpVersion.Version20,
            DefaultVersionPolicy = HttpVersionPolicy.RequestVersionOrLower,
        };
        using var request = new HttpRequestMessage(HttpMethod.Get, endpoint);
        request.Headers.UserAgent.ParseAdd("ai-dev-os-stage17-egress-canary/1.0");
        using HttpResponseMessage response = client.Send(
            request,
            HttpCompletionOption.ResponseHeadersRead);
        int status = (int)response.StatusCode;
        bool redirect = status is >= 300 and < 400;
        bool passed = status is >= 200 and < 300 or 400 or 401 or 403 or 404 or 405 or 429;
        return new EgressCanaryOutcome(
            passed && !redirect,
            passed && !redirect ? "provider-endpoint-reached" : "provider-endpoint-refused",
            endpointFingerprint,
            redirect);
    }

    private static bool IsPublicAddress(IPAddress address)
    {
        if (IPAddress.IsLoopback(address) || address.IsIPv6LinkLocal || address.IsIPv6Multicast ||
            address.IsIPv6SiteLocal)
        {
            return false;
        }

        if (address.IsIPv4MappedToIPv6)
        {
            return IsPublicAddress(address.MapToIPv4());
        }

        byte[] bytes = address.GetAddressBytes();
        if (address.AddressFamily == AddressFamily.InterNetwork)
        {
            return bytes[0] is >= 1 and <= 223 &&
                bytes[0] != 10 &&
                bytes[0] != 127 &&
                !(bytes[0] == 100 && bytes[1] is >= 64 and <= 127) &&
                !(bytes[0] == 169 && bytes[1] == 254) &&
                !(bytes[0] == 172 && bytes[1] is >= 16 and <= 31) &&
                !(bytes[0] == 192 && bytes[1] == 0 && bytes[2] is 0 or 2) &&
                !(bytes[0] == 192 && bytes[1] == 31 && bytes[2] == 196) &&
                !(bytes[0] == 192 && bytes[1] == 52 && bytes[2] == 193) &&
                !(bytes[0] == 192 && bytes[1] == 88 && bytes[2] == 99) &&
                !(bytes[0] == 192 && bytes[1] == 168) &&
                !(bytes[0] == 192 && bytes[1] == 175 && bytes[2] == 48) &&
                !(bytes[0] == 198 && bytes[1] is 18 or 19) &&
                !(bytes[0] == 198 && bytes[1] == 51 && bytes[2] == 100) &&
                !(bytes[0] == 203 && bytes[1] == 0 && bytes[2] == 113);
        }

        if (address.AddressFamily != AddressFamily.InterNetworkV6 ||
            (bytes[0] & 0xE0) != 0x20)
        {
            return false;
        }

        // 2001::/23 contains IETF protocol assignments rather than ordinary
        // destination space; 2001:db8::/32 is documentation-only and
        // 2002::/16 is the deprecated 6to4 relay range.
        return !(bytes[0] == 0x20 && bytes[1] == 0x01 && bytes[2] <= 0x01) &&
            !(bytes[0] == 0x20 && bytes[1] == 0x01 && bytes[2] == 0x0D && bytes[3] == 0xB8) &&
            !(bytes[0] == 0x20 && bytes[1] == 0x02);
    }

    private sealed record EgressCanaryOutcome(
        bool Passed,
        string Code,
        string EndpointFingerprint,
        bool RedirectObserved);

    private sealed class SupervisorSession : IDisposable
    {
        private readonly RuntimeClosureLease closure;
        private readonly string token;
        private nint jobHandle;
        private nint helperProcessHandle;
        private nint helperRequestWriteHandle;
        private nint helperResponseReadHandle;
        private bool disposed;

        internal SupervisorSession(RuntimeClosureLease closure, string token)
        {
            this.closure = closure;
            this.token = token;
            jobHandle = CreatePrivateJob();
            LaunchHelper();
        }

        internal int Proxy(nint controllerRead, nint controllerWrite, byte[] initial)
        {
            WriteFrame(helperRequestWriteHandle, initial);
            while (true)
            {
                byte[] fromHelper = ReadFrame(helperResponseReadHandle, FrameTimeoutMilliseconds);
                WriteFrame(controllerWrite, fromHelper);
                if (!TryReadCheckpointPhase(fromHelper, out string phase, out string status))
                {
                    return 65;
                }

                if (string.Equals(status, "refused", StringComparison.Ordinal))
                {
                    _ = WaitForSingleObject(helperProcessHandle, HelperWaitMilliseconds);
                    return 70;
                }

                if (string.Equals(phase, "cleanup-complete", StringComparison.Ordinal))
                {
                    return WaitForSuccessfulHelperExit() ? 0 : 70;
                }

                if (phase is not ("setup-complete" or "target-suspended" or "target-ready" or "target-exited"))
                {
                    continue;
                }

                byte[] control;
                try
                {
                    control = ReadFrame(controllerRead, FrameTimeoutMilliseconds);
                }
                catch (ChannelClosedException)
                {
                    CloseNativeHandle(ref helperRequestWriteHandle);
                    return WaitForHelperExit() ? 7 : 70;
                }

                if (!TryParseControl(control, phase, out string action))
                {
                    WriteStableRefusal(controllerWrite, "invalid-session-control");
                    return 65;
                }

                if (string.Equals(action, "continue", StringComparison.Ordinal))
                {
                    WriteFrame(helperRequestWriteHandle, control);
                    continue;
                }

                if (!string.Equals(action, "cancel", StringComparison.Ordinal) ||
                    !TerminateProcess(helperProcessHandle, InjectedCancellationExitCode) ||
                    WaitForSingleObject(helperProcessHandle, HelperWaitMilliseconds) != WaitObject0)
                {
                    WriteStableRefusal(controllerWrite, "helper-cancellation-unconfirmed");
                    return 70;
                }

                _ = TerminateJobObject(jobHandle, InjectedCancellationExitCode);
                WriteFrame(controllerWrite, JsonSerializer.SerializeToUtf8Bytes(new
                {
                    schemaVersion = 1,
                    protocolVersion = ProtocolVersion,
                    status = "cancelled",
                    phase = "helper-terminated",
                }));
                try
                {
                    byte[] acknowledgement = ReadFrame(controllerRead, 5_000);
                    if (!TryParseControl(acknowledgement, "helper-terminated", out string finalAction) ||
                        !string.Equals(finalAction, "continue", StringComparison.Ordinal))
                    {
                        return 65;
                    }
                }
                catch (ChannelClosedException)
                {
                    // Closing the control channel after cancellation is a
                    // fail-closed terminal acknowledgement.
                }

                return 17;
            }
        }

        public void Dispose()
        {
            if (disposed)
            {
                return;
            }

            disposed = true;
            CloseNativeHandle(ref helperRequestWriteHandle);
            CloseNativeHandle(ref helperResponseReadHandle);
            CloseNativeHandle(ref helperProcessHandle);
            CloseNativeHandle(ref jobHandle);
        }

        private void LaunchHelper()
        {
            nint helperThread = 0;
            nint helperRequestRead = 0;
            nint helperResponseWrite = 0;
            nint nullHandle = 0;
            nint attributeList = 0;
            nint handleList = 0;
            nint environment = 0;
            bool attributesInitialized = false;
            bool jobInheritable = false;
            var inheritable = new SecurityAttributes
            {
                Length = checked((uint)Marshal.SizeOf<SecurityAttributes>()),
                InheritHandle = true,
            };

            try
            {
                Ensure(CreatePipe(out helperRequestRead, out helperRequestWriteHandle, ref inheritable, MaximumFrameBytes));
                Ensure(SetHandleInformation(helperRequestWriteHandle, HandleFlagInherit, 0));
                Ensure(CreatePipe(out helperResponseReadHandle, out helperResponseWrite, ref inheritable, MaximumFrameBytes));
                Ensure(SetHandleInformation(helperResponseReadHandle, HandleFlagInherit, 0));
                nullHandle = CreateFileW(
                    "NUL",
                    GenericRead | GenericWrite,
                    FileShareRead | FileShareWrite,
                    ref inheritable,
                    OpenExisting,
                    0,
                    0);
                EnsureHandle(nullHandle);
                Ensure(SetHandleInformation(jobHandle, HandleFlagInherit, HandleFlagInherit));
                jobInheritable = true;

                InitializeHandleList(
                    [helperRequestRead, helperResponseWrite, jobHandle, nullHandle],
                    out attributeList,
                    out attributesInitialized,
                    out handleList);
                environment = CreateMinimalEnvironment();
                string helperImage = closure.AuthorizeImage(HelperImageName);
                closure.AssertOpen();
                string command = string.Join(
                    ' ',
                    Quote(helperImage),
                    "run-session",
                    helperRequestRead.ToInt64().ToString(CultureInfo.InvariantCulture),
                    helperResponseWrite.ToInt64().ToString(CultureInfo.InvariantCulture),
                    jobHandle.ToInt64().ToString(CultureInfo.InvariantCulture));
                char[] writableCommandLine = (command + '\0').ToCharArray();
                var startup = new StartupInfoEx
                {
                    StartupInfo = new StartupInfo
                    {
                        Cb = checked((uint)Marshal.SizeOf<StartupInfoEx>()),
                        Flags = StartfUseStdHandles,
                        StandardInput = nullHandle,
                        StandardOutput = nullHandle,
                        StandardError = nullHandle,
                    },
                    AttributeList = attributeList,
                };

                Ensure(CreateProcessW(
                    helperImage,
                    writableCommandLine,
                    0,
                    0,
                    inheritHandles: true,
                    CreateUnicodeEnvironment | ExtendedStartupInfoPresent | CreateNoWindow,
                    environment,
                    closure.Root,
                    ref startup,
                    out ProcessInformation processInformation));
                helperProcessHandle = processInformation.Process;
                helperThread = processInformation.Thread;
                if (!ConfirmProcessImage(helperProcessHandle, helperImage))
                {
                    throw new NativeRuntimeException("helper-image-unconfirmed");
                }
            }
            finally
            {
                if (jobInheritable)
                {
                    _ = SetHandleInformation(jobHandle, HandleFlagInherit, 0);
                }

                if (attributesInitialized)
                {
                    DeleteProcThreadAttributeList(attributeList);
                }

                FreeUnmanaged(ref attributeList);
                FreeUnmanaged(ref handleList);
                FreeUnmanaged(ref environment);
                CloseNativeHandle(ref helperThread);
                CloseNativeHandle(ref helperRequestRead);
                CloseNativeHandle(ref helperResponseWrite);
                CloseNativeHandle(ref nullHandle);
            }
        }

        private bool WaitForHelperExit() =>
            WaitForSingleObject(helperProcessHandle, HelperWaitMilliseconds) == WaitObject0;

        private bool WaitForSuccessfulHelperExit()
        {
            if (!WaitForHelperExit() || !GetExitCodeProcess(helperProcessHandle, out uint code))
            {
                return false;
            }

            return code == 0;
        }
    }

    private static nint CreatePrivateJob()
    {
        nint handle = CreateJobObjectW(0, null);
        EnsureHandle(handle);
        try
        {
            var limits = new JobObjectExtendedLimitInformation
            {
                BasicLimitInformation = new JobObjectBasicLimitInformation
                {
                    PerProcessUserTimeLimit = 300_000_000,
                    PerJobUserTimeLimit = 600_000_000,
                    LimitFlags = JobObjectLimitProcessTime |
                        JobObjectLimitJobTime |
                        JobObjectLimitActiveProcess |
                        JobObjectLimitProcessMemory |
                        JobObjectLimitJobMemory |
                        JobObjectLimitKillOnJobClose,
                    ActiveProcessLimit = 1,
                },
                ProcessMemoryLimit = 402_653_184,
                JobMemoryLimit = 536_870_912,
            };
            Ensure(SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformationClass,
                ref limits,
                checked((uint)Marshal.SizeOf<JobObjectExtendedLimitInformation>())));
            return handle;
        }
        catch
        {
            CloseNativeHandle(ref handle);
            throw;
        }
    }

    private static bool RecoverExact(string token)
    {
        string temp = Path.TrimEndingDirectorySeparator(Path.GetFullPath(Path.GetTempPath()));
        string staging = ExactTempChild(temp, $"ai-dev-os-stage17-runtime-{token}");
        string canary = ExactTempChild(temp, $"ai-dev-os-stage17-runtime-canary-{token}");
        string profileName = $"AiDevOs.Stage17.Runtime.{token}";
        string stagedFixture = Path.Combine(staging, $"stage17-helper-fixture-{token}.exe");
        string markerRoot = Path.Combine(staging, "marker");
        string marker = Path.Combine(markerRoot, $"stage17-helper-lifecycle-{token}.marker");
        string journal = Path.Combine(staging, $"stage17-runtime-{token}.journal");
        string allowed = Path.Combine(staging, "allowed.txt");
        string canaryFile = Path.Combine(canary, "canary.txt");

        for (int attempt = 0; attempt < 50; attempt++)
        {
            TryDeleteFile(marker);
            TryDeleteFile(journal);
            TryDeleteFile(stagedFixture);
            TryDeleteFile(allowed);
            TryDeleteFile(canaryFile);
            TryDeleteEmptyDirectory(markerRoot);
            TryDeleteEmptyDirectory(staging);
            TryDeleteEmptyDirectory(canary);
            // Recovery is deliberately idempotent. The helper may have
            // completed its own cleanup immediately before it was observed as
            // terminated, in which case DeleteAppContainerProfile reports that
            // the already-absent profile was not found. Post-state is the
            // authority: a derivation failure is represented as present by
            // ProfileRegistryExists and therefore still refuses confirmation.
            _ = DeleteAppContainerProfile(profileName);
            if (!File.Exists(marker) &&
                !File.Exists(journal) &&
                !File.Exists(stagedFixture) &&
                !File.Exists(allowed) &&
                !File.Exists(canaryFile) &&
                !Directory.Exists(markerRoot) &&
                !Directory.Exists(staging) &&
                !Directory.Exists(canary) &&
                !ProfileRegistryExists(profileName))
            {
                return true;
            }

            Thread.Sleep(100);
        }

        return false;
    }

    private static bool ProfileRegistryExists(string profileName)
    {
        nint sidPointer = 0;
        try
        {
            if (DeriveAppContainerSidFromAppContainerName(profileName, out sidPointer) != 0 || sidPointer == 0)
            {
                return true;
            }

            string sid = new SecurityIdentifier(sidPointer).Value;
            const string root = @"Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppContainer";
            using RegistryKey? mappings = Registry.CurrentUser.OpenSubKey($@"{root}\Mappings\{sid}");
            using RegistryKey? storage = Registry.CurrentUser.OpenSubKey($@"{root}\Storage\{profileName}");
            return mappings is not null || storage is not null;
        }
        finally
        {
            if (sidPointer != 0)
            {
                _ = FreeSid(sidPointer);
            }
        }
    }

    private static bool TryParseRequest(
        ReadOnlySpan<byte> payload,
        string runToken,
        string helperDigest,
        string helperPayloadDigest,
        string targetDigest,
        out string token,
        out string scenario)
    {
        token = string.Empty;
        scenario = string.Empty;
        try
        {
            using JsonDocument document = JsonDocument.Parse(payload.ToArray());
            JsonElement root = document.RootElement;
            if (!HasShape(root,
                    ["schemaVersion", "protocolVersion", "command", "scenario", "token",
                        "helperSha256", "helperPayloadSha256", "fixtureSha256"]) ||
                root.GetProperty("schemaVersion").GetInt32() != 1 ||
                root.GetProperty("protocolVersion").GetInt32() != ProtocolVersion ||
                !string.Equals(root.GetProperty("command").GetString(), "run-lifecycle-scenario", StringComparison.Ordinal) ||
                !string.Equals(root.GetProperty("helperSha256").GetString(), helperDigest, StringComparison.Ordinal) ||
                !string.Equals(root.GetProperty("helperPayloadSha256").GetString(), helperPayloadDigest, StringComparison.Ordinal) ||
                !string.Equals(root.GetProperty("fixtureSha256").GetString(), targetDigest, StringComparison.Ordinal))
            {
                return false;
            }

            token = root.GetProperty("token").GetString() ?? string.Empty;
            scenario = root.GetProperty("scenario").GetString() ?? string.Empty;
            int scenarioIndex = Array.IndexOf(Scenarios, scenario);
            return IsRunToken(runToken) &&
                IsRunToken(token) &&
                scenarioIndex >= 0 &&
                string.Equals(
                    token,
                    RuntimeClosureLease.DeriveScenarioToken(runToken, scenarioIndex),
                    StringComparison.Ordinal);
        }
        catch (Exception exception) when (!IsFatal(exception))
        {
            return false;
        }
    }

    private static bool TryParseControl(ReadOnlySpan<byte> payload, string phase, out string action)
    {
        action = string.Empty;
        try
        {
            using JsonDocument document = JsonDocument.Parse(payload.ToArray());
            JsonElement root = document.RootElement;
            if (!HasShape(root, ["schemaVersion", "protocolVersion", "command", "phase"]) ||
                root.GetProperty("schemaVersion").GetInt32() != 1 ||
                root.GetProperty("protocolVersion").GetInt32() != ProtocolVersion ||
                !string.Equals(root.GetProperty("phase").GetString(), phase, StringComparison.Ordinal))
            {
                return false;
            }

            action = root.GetProperty("command").GetString() ?? string.Empty;
            return action is "continue" or "cancel";
        }
        catch (Exception exception) when (!IsFatal(exception))
        {
            return false;
        }
    }

    private static bool TryReadCheckpointPhase(ReadOnlySpan<byte> payload, out string phase, out string status)
    {
        phase = string.Empty;
        status = string.Empty;
        try
        {
            using JsonDocument document = JsonDocument.Parse(payload.ToArray());
            JsonElement root = document.RootElement;
            status = root.GetProperty("status").GetString() ?? string.Empty;
            if (string.Equals(status, "refused", StringComparison.Ordinal))
            {
                return true;
            }

            phase = root.GetProperty("phase").GetString() ?? string.Empty;
            return string.Equals(status, "checkpoint", StringComparison.Ordinal) &&
                phase is "request-accepted" or "setup-complete" or "target-suspended" or
                    "target-ready" or "target-exited" or "cleanup-complete";
        }
        catch (Exception exception) when (!IsFatal(exception))
        {
            return false;
        }
    }

    private static bool HasShape(JsonElement root, IReadOnlyList<string> names)
    {
        if (root.ValueKind != JsonValueKind.Object)
        {
            return false;
        }

        HashSet<string> remaining = new(names, StringComparer.Ordinal);
        int count = 0;
        foreach (JsonProperty property in root.EnumerateObject())
        {
            count++;
            if (!remaining.Remove(property.Name))
            {
                return false;
            }
        }

        return count == names.Count && remaining.Count == 0;
    }

    private static byte[] ReadFrame(nint handle, int timeoutMilliseconds)
    {
        byte[] header = new byte[sizeof(int)];
        ReadExact(handle, header, timeoutMilliseconds);
        int length = BinaryPrimitives.ReadInt32LittleEndian(header);
        if (length is < 1 or > MaximumFrameBytes)
        {
            throw new NativeRuntimeException("frame-length-invalid");
        }

        byte[] payload = new byte[length];
        ReadExact(handle, payload, timeoutMilliseconds);
        _ = new UTF8Encoding(false, true).GetString(payload);
        return payload;
    }

    private static void ReadExact(nint handle, byte[] buffer, int timeoutMilliseconds)
    {
        int offset = 0;
        Stopwatch timer = Stopwatch.StartNew();
        while (offset < buffer.Length)
        {
            if (!PeekNamedPipe(handle, 0, 0, 0, out uint available, 0))
            {
                int error = Marshal.GetLastWin32Error();
                if (error is ErrorBrokenPipe or ErrorNoData)
                {
                    throw new ChannelClosedException();
                }

                throw new NativeRuntimeException("pipe-peek-failed");
            }

            if (available == 0)
            {
                if (timer.ElapsedMilliseconds >= timeoutMilliseconds)
                {
                    throw new NativeRuntimeException("frame-timeout");
                }

                Thread.Sleep(5);
                continue;
            }

            uint requested = checked((uint)Math.Min(buffer.Length - offset, available));
            byte[] chunk = new byte[requested];
            if (!ReadFile(handle, chunk, requested, out uint read, 0) || read == 0)
            {
                int error = Marshal.GetLastWin32Error();
                if (error is ErrorBrokenPipe or ErrorNoData)
                {
                    throw new ChannelClosedException();
                }

                throw new NativeRuntimeException("pipe-read-failed");
            }

            Buffer.BlockCopy(chunk, 0, buffer, offset, checked((int)read));
            offset = checked(offset + (int)read);
        }
    }

    private static void WriteFrame(nint handle, byte[] payload)
    {
        if (payload.Length is < 1 or > MaximumFrameBytes)
        {
            throw new NativeRuntimeException("outbound-frame-invalid");
        }

        byte[] frame = new byte[payload.Length + sizeof(int)];
        BinaryPrimitives.WriteInt32LittleEndian(frame, payload.Length);
        payload.CopyTo(frame.AsSpan(sizeof(int)));
        if (!WriteFile(handle, frame, checked((uint)frame.Length), out uint written, 0) ||
            written != frame.Length)
        {
            throw new ChannelClosedException();
        }
    }

    private static void WriteStableRefusal(nint handle, string code) =>
        WriteFrame(handle, JsonSerializer.SerializeToUtf8Bytes(new
        {
            schemaVersion = 1,
            protocolVersion = ProtocolVersion,
            status = "refused",
            code,
        }));

    private static void TryWriteStableRefusal(nint handle, string code)
    {
        if (handle == 0 || handle == new nint(-1))
        {
            return;
        }

        try
        {
            WriteStableRefusal(handle, code);
        }
        catch (Exception exception) when (!IsFatal(exception))
        {
            // The peer is already gone; cleanup remains exact and local.
        }
    }

    private static void InitializeHandleList(
        nint[] handles,
        out nint attributeList,
        out bool initialized,
        out nint handleList)
    {
        attributeList = 0;
        initialized = false;
        handleList = 0;
        nuint bytes = 0;
        _ = InitializeProcThreadAttributeList(0, 1, 0, ref bytes);
        if (bytes == 0)
        {
            throw new NativeRuntimeException("attribute-size-query-failed");
        }

        attributeList = Marshal.AllocHGlobal(checked((int)bytes));
        Ensure(InitializeProcThreadAttributeList(attributeList, 1, 0, ref bytes));
        initialized = true;
        handleList = Marshal.AllocHGlobal(checked(handles.Length * nint.Size));
        for (int index = 0; index < handles.Length; index++)
        {
            Marshal.WriteIntPtr(handleList, checked(index * nint.Size), handles[index]);
        }

        Ensure(UpdateProcThreadAttribute(
            attributeList,
            0,
            ProcThreadAttributeHandleList,
            handleList,
            checked((nuint)(handles.Length * nint.Size)),
            0,
            0));
    }

    private static nint CreateMinimalEnvironment()
    {
        string windows = Path.GetFullPath(Environment.GetFolderPath(Environment.SpecialFolder.Windows));
        string drive = Path.TrimEndingDirectorySeparator(Path.GetPathRoot(windows) ??
            throw new NativeRuntimeException("system-drive-unavailable"));
        string temp = Path.TrimEndingDirectorySeparator(Path.GetFullPath(Path.GetTempPath()));
        string block = string.Join('\0',
            "COMPlus_EnableDiagnostics=0",
            "DOTNET_EnableDiagnostics=0",
            "DOTNET_NOLOGO=1",
            $"SystemDrive={drive}",
            $"SystemRoot={windows}",
            $"TEMP={temp}",
            $"TMP={temp}",
            $"WINDIR={windows}") + '\0';
        return Marshal.StringToHGlobalUni(block);
    }

    private static bool ConfirmProcessImage(nint process, string expected)
    {
        char[] path = new char[1024];
        uint length = checked((uint)path.Length);
        return QueryFullProcessImageNameW(process, 0, path, ref length) &&
            string.Equals(
                Path.GetFullPath(new string(path, 0, checked((int)length))),
                expected,
                StringComparison.OrdinalIgnoreCase);
    }

    private static string Quote(string value)
    {
        var output = new StringBuilder(value.Length + 2);
        output.Append('"');
        int slashCount = 0;
        foreach (char character in value)
        {
            if (character == '\\')
            {
                slashCount++;
            }
            else if (character == '"')
            {
                output.Append('\\', checked((slashCount * 2) + 1));
                output.Append('"');
                slashCount = 0;
            }
            else
            {
                output.Append('\\', slashCount);
                output.Append(character);
                slashCount = 0;
            }
        }

        output.Append('\\', checked(slashCount * 2));
        output.Append('"');
        return output.ToString();
    }

    private static string ExactTempChild(string temp, string name)
    {
        string combined = Path.Combine(temp, name);
        string full = Path.GetFullPath(combined);
        if (!string.Equals(full, combined, StringComparison.Ordinal) ||
            !string.Equals(Path.GetDirectoryName(full), temp, StringComparison.OrdinalIgnoreCase))
        {
            throw new NativeRuntimeException("recovery-path-invalid");
        }

        return full;
    }

    private static void TryDeleteFile(string path)
    {
        try
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
        catch (Exception exception) when (!IsFatal(exception))
        {
            // Retried by the bounded recovery loop.
        }
    }

    private static void TryDeleteEmptyDirectory(string path)
    {
        try
        {
            if (Directory.Exists(path) && !Directory.EnumerateFileSystemEntries(path).GetEnumerator().MoveNext())
            {
                Directory.Delete(path, recursive: false);
            }
        }
        catch (Exception exception) when (!IsFatal(exception))
        {
            // Retried by the bounded recovery loop.
        }
    }

    private static bool IsRunToken(string value)
    {
        if (value.Length != 32)
        {
            return false;
        }

        foreach (char character in value)
        {
            if (character is not (>= '0' and <= '9') and not (>= 'a' and <= 'f'))
            {
                return false;
            }
        }

        return true;
    }

    private static bool IsAuthorizedScenarioToken(string runToken, string scenarioToken)
    {
        if (!IsRunToken(runToken) || !IsRunToken(scenarioToken))
        {
            return false;
        }

        for (int index = 0; index < Scenarios.Length; index++)
        {
            if (string.Equals(
                    scenarioToken,
                    RuntimeClosureLease.DeriveScenarioToken(runToken, index),
                    StringComparison.Ordinal))
            {
                return true;
            }
        }

        return false;
    }

    private static nint ParseHandle(string value)
    {
        if (!long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out long parsed) ||
            parsed <= 0 || (nint.Size == sizeof(int) && parsed > int.MaxValue))
        {
            throw new NativeRuntimeException("handle-invalid");
        }

        return new nint(parsed);
    }

    private static void Ensure(bool success)
    {
        if (!success)
        {
            throw new NativeRuntimeException("native-operation-failed");
        }
    }

    private static void EnsureHandle(nint handle)
    {
        if (handle == 0 || handle == new nint(-1))
        {
            throw new NativeRuntimeException("native-handle-invalid");
        }
    }

    private static void FreeUnmanaged(ref nint pointer)
    {
        if (pointer != 0)
        {
            Marshal.FreeHGlobal(pointer);
            pointer = 0;
        }
    }

    private static void CloseNativeHandle(ref nint handle)
    {
        if (handle != 0 && handle != new nint(-1))
        {
            _ = CloseHandle(handle);
        }

        handle = 0;
    }

    private static void WriteConsole(CanonicalObject value)
    {
        using Stream output = Console.OpenStandardOutput();
        byte[] bytes = CanonicalJson.Serialize(value);
        output.Write(bytes, 0, bytes.Length);
        output.WriteByte((byte)'\n');
        output.Flush();
    }

    private static bool IsFatal(Exception exception) =>
        exception is OutOfMemoryException or StackOverflowException or AccessViolationException;

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes
    {
        internal uint Length;
        internal nint SecurityDescriptor;
        [MarshalAs(UnmanagedType.Bool)]
        internal bool InheritHandle;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfo
    {
        internal uint Cb;
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
    private struct StartupInfoEx
    {
        internal StartupInfo StartupInfo;
        internal nint AttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        internal nint Process;
        internal nint Thread;
        internal uint ProcessId;
        internal uint ThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicLimitInformation
    {
        internal long PerProcessUserTimeLimit;
        internal long PerJobUserTimeLimit;
        internal uint LimitFlags;
        internal nuint MinimumWorkingSetSize;
        internal nuint MaximumWorkingSetSize;
        internal uint ActiveProcessLimit;
        internal nuint Affinity;
        internal uint PriorityClass;
        internal uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        internal ulong ReadOperationCount;
        internal ulong WriteOperationCount;
        internal ulong OtherOperationCount;
        internal ulong ReadTransferCount;
        internal ulong WriteTransferCount;
        internal ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectExtendedLimitInformation
    {
        internal JobObjectBasicLimitInformation BasicLimitInformation;
        internal IoCounters IoInfo;
        internal nuint ProcessMemoryLimit;
        internal nuint JobMemoryLimit;
        internal nuint PeakProcessMemoryUsed;
        internal nuint PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", EntryPoint = "CreateJobObjectW", ExactSpelling = true, CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern nint CreateJobObjectW(nint attributes, string? name);

    [DllImport("kernel32.dll", EntryPoint = "SetInformationJobObject", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(nint job, int informationClass, ref JobObjectExtendedLimitInformation information, uint length);

    [DllImport("kernel32.dll", EntryPoint = "TerminateJobObject", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateJobObject(nint job, uint exitCode);

    [DllImport("kernel32.dll", EntryPoint = "CreatePipe", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreatePipe(out nint readPipe, out nint writePipe, ref SecurityAttributes attributes, int size);

    [DllImport("kernel32.dll", EntryPoint = "CreateFileW", ExactSpelling = true, CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern nint CreateFileW(string name, uint access, uint share, ref SecurityAttributes attributes, uint disposition, uint flags, nint template);

    [DllImport("kernel32.dll", EntryPoint = "SetHandleInformation", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetHandleInformation(nint handle, uint mask, uint flags);

    [DllImport("kernel32.dll", EntryPoint = "InitializeProcThreadAttributeList", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool InitializeProcThreadAttributeList(nint list, uint count, uint flags, ref nuint size);

    [DllImport("kernel32.dll", EntryPoint = "UpdateProcThreadAttribute", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UpdateProcThreadAttribute(nint list, uint flags, nuint attribute, nint value, nuint size, nint previous, nint returnSize);

    [DllImport("kernel32.dll", EntryPoint = "DeleteProcThreadAttributeList", ExactSpelling = true)]
    private static extern void DeleteProcThreadAttributeList(nint list);

    [DllImport("kernel32.dll", EntryPoint = "CreateProcessW", ExactSpelling = true, CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcessW(string applicationName, [In, Out] char[] commandLine, nint processAttributes, nint threadAttributes, [MarshalAs(UnmanagedType.Bool)] bool inheritHandles, uint flags, nint environment, string currentDirectory, ref StartupInfoEx startupInfo, out ProcessInformation processInformation);

    [DllImport("kernel32.dll", EntryPoint = "QueryFullProcessImageNameW", ExactSpelling = true, CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryFullProcessImageNameW(nint process, uint flags, [Out] char[] imageName, ref uint size);

    [DllImport("kernel32.dll", EntryPoint = "TerminateProcess", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateProcess(nint process, uint exitCode);

    [DllImport("kernel32.dll", EntryPoint = "WaitForSingleObject", ExactSpelling = true, SetLastError = true)]
    private static extern uint WaitForSingleObject(nint handle, uint milliseconds);

    [DllImport("kernel32.dll", EntryPoint = "GetExitCodeProcess", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetExitCodeProcess(nint process, out uint exitCode);

    [DllImport("kernel32.dll", EntryPoint = "ReadFile", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ReadFile(nint handle, byte[] buffer, uint requested, out uint read, nint overlapped);

    [DllImport("kernel32.dll", EntryPoint = "WriteFile", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WriteFile(nint handle, byte[] buffer, uint requested, out uint written, nint overlapped);

    [DllImport("kernel32.dll", EntryPoint = "PeekNamedPipe", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool PeekNamedPipe(nint handle, nint buffer, uint bufferSize, nint bytesRead, out uint available, nint bytesLeft);

    [DllImport("kernel32.dll", EntryPoint = "CloseHandle", ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(nint handle);

    [DllImport("userenv.dll", EntryPoint = "DeleteAppContainerProfile", ExactSpelling = true, CharSet = CharSet.Unicode)]
    private static extern int DeleteAppContainerProfile(string profileName);

    [DllImport("userenv.dll", EntryPoint = "DeriveAppContainerSidFromAppContainerName", ExactSpelling = true, CharSet = CharSet.Unicode)]
    private static extern int DeriveAppContainerSidFromAppContainerName(string profileName, out nint sid);

    [DllImport("advapi32.dll", EntryPoint = "FreeSid", ExactSpelling = true)]
    private static extern nint FreeSid(nint sid);
}

internal sealed class NativeRuntimeException : Exception
{
    internal NativeRuntimeException(string code)
        : base(code)
    {
    }
}

internal sealed class ChannelClosedException : Exception
{
}

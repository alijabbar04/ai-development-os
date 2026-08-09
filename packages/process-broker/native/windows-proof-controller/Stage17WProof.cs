using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using AiDevOs.WindowsRuntime;

[assembly: DefaultDllImportSearchPaths(DllImportSearchPath.System32)]

namespace AiDevOs.WindowsSandboxFeasibilityProbe;

internal static partial class AppContainerSyntheticProcessProof
{
    private const string Stage17WSupervisorName = "AI.DevOS.WindowsSupervisor.exe";
    private const string Stage17WHelperName = "AI.DevOS.WindowsHelper.exe";
    private const string Stage17WHelperPayloadName = "AI.DevOS.WindowsHelper.dll";
    private const string Stage17WTargetName = "AI.DevOS.WindowsBoundaryFixture.exe";
    private const string Stage17WRuntimeSourceEnvelopeFingerprint =
        "16f327aa858f25e85c9f335d658e1879d1c93729940648df19cd6966326eb5c8";
    private const string Stage17WAnthropicEgressEndpoint = "https://api.anthropic.com/v1/models";
    private const string Stage17WOpenAiEgressEndpoint = "https://api.openai.com/v1/models";
    private const uint Stage17WInjectedSupervisorExitCode = 23;
    private const int Stage17WMaximumRecoverySupervisors = 4;
    private const int Stage17WMaximumSupervisors = 12;
    private const int Stage17WMaximumHelpers = 8;
    private const int Stage17WMaximumTargets = 6;
    private const int Stage17WMaximumControls = 2;
    private const int Stage17WMaximumProcesses = 30;

    private static readonly Stage17WScenario[] Stage17WScenarios =
    [
        new("normal-lifecycle", "cleanup-complete", false),
        new("control-disconnect-before-target", "setup-complete", false),
        new("helper-terminated-after-setup", "setup-complete", true),
        new("helper-terminated-target-suspended", "target-suspended", true),
        new("supervisor-terminated-target-suspended", "target-suspended", false),
        new("supervisor-terminated-target-running", "target-ready", false),
        new("supervisor-helper-terminated-target-running", "target-ready", true),
        new("supervisor-terminated-after-target-exit", "target-exited", true),
    ];

    internal static bool RunStage17WReadOnlySelfTest()
    {
        const string runToken = "0123456789abcdef0123456789abcdef";
        string first = DeriveStage17WScenarioToken(runToken, 0);
        string second = DeriveStage17WScenarioToken(runToken, 1);
        Stage17WPlan plan = CreateStage17WPlan(runToken);
        string anthropicFingerprint = ExpectedStage17WEgressFingerprint("anthropic");
        Stage17WEgressProviderResult acceptedEgress = ParseStage17WEgressResponse(
            "anthropic",
            JsonSerializer.SerializeToUtf8Bytes(new
            {
                schemaVersion = 1,
                protocolVersion = ProtocolVersion,
                status = "passed",
                code = "provider-endpoint-reached",
                provider = "anthropic",
                endpointFingerprint = anthropicFingerprint,
                redirectObserved = false,
                proxyEnabled = false,
                quicEnabled = false,
                credentialsUsed = false,
                requestBodyBytes = 0,
            }));
        Stage17WEgressProviderResult substitutedEgress = ParseStage17WEgressResponse(
            "anthropic",
            JsonSerializer.SerializeToUtf8Bytes(new
            {
                schemaVersion = 1,
                protocolVersion = ProtocolVersion,
                status = "passed",
                code = "provider-endpoint-reached",
                provider = "anthropic",
                endpointFingerprint = ExpectedStage17WEgressFingerprint("openai"),
                redirectObserved = false,
                proxyEnabled = false,
                quicEnabled = false,
                credentialsUsed = false,
                requestBodyBytes = 0,
            }));
        return
            RuntimeClosureLease.RunReadOnlySelfTest() &&
            first.Length == 32 &&
            first.All(IsLowerHexCharacter) &&
            !string.Equals(first, second, StringComparison.Ordinal) &&
            plan.Status == "planned" &&
            plan.Scenarios.Count == 8 &&
            plan.MaximumProcesses == Stage17WMaximumProcesses &&
            acceptedEgress.Status == "passed" &&
            substitutedEgress.Status == "failed" &&
            CreateStage17WPlan(runToken.ToUpperInvariant()).Status == "refused";
    }

    internal static string Stage17WReadOnlyDigest() =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
            "windows-proof-controller-v2|8|8|8|12|8|6|2|30|" +
            Stage17WAnthropicEgressEndpoint + "|" + Stage17WOpenAiEgressEndpoint +
            "|endpoint-fingerprint-bound")))
            .ToLowerInvariant();

    internal static Stage17WPlan CreateStage17WPlan(string runToken)
    {
        if (!LifecycleTokenPattern().IsMatch(runToken))
        {
            return Stage17WPlan.Refused;
        }

        List<Stage17WPlanScenario> scenarios = [];
        for (int index = 0; index < Stage17WScenarios.Length; index++)
        {
            string token = DeriveStage17WScenarioToken(runToken, index);
            scenarios.Add(new Stage17WPlanScenario(
                Index: index + 1,
                Code: Stage17WScenarios[index].Code,
                ScenarioToken: token,
                ProfileName: $"AiDevOs.Stage17.Runtime.{token}",
                StagingLeaf: $"ai-dev-os-stage17-runtime-{token}",
                CanaryLeaf: $"ai-dev-os-stage17-runtime-canary-{token}",
                RecoverySupervisorPlanned: Stage17WScenarios[index].RecoveryPlanned));
        }

        return new Stage17WPlan(
            SchemaVersion: 1,
            Status: "planned",
            CandidateId: RuntimeClosureLease.CandidateId,
            RunToken: runToken,
            ScenarioAttempts: 8,
            MaximumProfiles: 8,
            MaximumInitialSupervisors: 8,
            MaximumRecoverySupervisors: Stage17WMaximumRecoverySupervisors,
            MaximumSupervisors: Stage17WMaximumSupervisors,
            MaximumHelpers: Stage17WMaximumHelpers,
            MaximumTargets: Stage17WMaximumTargets,
            MaximumOrdinaryControls: Stage17WMaximumControls,
            MaximumProcesses: Stage17WMaximumProcesses,
            Scenarios: scenarios);
    }

    internal static Stage17WProofResult RunStage17W(
        string runToken,
        ReviewedProofAuthorization authorization)
    {
        if (!MutationGate.Authorized(authorization) || !LifecycleTokenPattern().IsMatch(runToken))
        {
            return Stage17WProofResult.Refused(runToken);
        }

        using RuntimeClosureLease closure =
            RuntimeClosureLease.AcquireInstalled(
                runToken,
                Stage17WSupervisorName,
                Stage17WRuntimeSourceEnvelopeFingerprint);
        string supervisorImage = closure.AuthorizeImage(Stage17WSupervisorName);
        string helperImage = closure.AuthorizeImage(Stage17WHelperName);
        string targetImage = closure.AuthorizeImage(Stage17WTargetName);
        string helperDigest = closure.DigestOf(Stage17WHelperName);
        string helperPayloadDigest = closure.DigestOf(Stage17WHelperPayloadName);
        string targetDigest = closure.DigestOf(Stage17WTargetName);

        List<LifecycleResources> resources = [];
        List<Stage17WScenarioResult> scenarioResults = [];
        int initialSupervisors = 0;
        int recoverySupervisors = 0;
        int helpers = 0;
        int targets = 0;
        int controls = 0;
        int profiles = 0;
        bool stoppedAfterFailure = false;

        for (int controlIndex = 1; controlIndex <= Stage17WMaximumControls; controlIndex++)
        {
            if (!RunOrdinaryControl(closure, targetImage, runToken, controlIndex))
            {
                stoppedAfterFailure = true;
                break;
            }

            controls++;
        }

        for (int index = 0; !stoppedAfterFailure && index < Stage17WScenarios.Length; index++)
        {
            int projectedProcesses = 1 +
                (initialSupervisors + 1) +
                recoverySupervisors +
                (helpers + 1) +
                targets +
                controls;
            if (projectedProcesses > Stage17WMaximumProcesses ||
                initialSupervisors >= 8 || helpers >= Stage17WMaximumHelpers || profiles >= 8)
            {
                stoppedAfterFailure = true;
                break;
            }

            Stage17WScenario spec = Stage17WScenarios[index];
            string scenarioToken = DeriveStage17WScenarioToken(runToken, index);
            LifecycleResources scenarioResources = LifecycleResources.Create(scenarioToken);
            resources.Add(scenarioResources);
            LifecycleResidueScan before = ScanLifecycleResidue(helperImage, [scenarioResources]);
            if (!before.IsZero)
            {
                scenarioResults.Add(Stage17WScenarioResult.Failed(index + 1, spec.Code, "preexisting-scenario-state"));
                stoppedAfterFailure = true;
                break;
            }

            initialSupervisors++;
            helpers++;
            Stage17WScenarioExecution execution;
            using (var session = ControllerSession.Launch(closure, supervisorImage))
            {
                execution = RunOneStage17WScenario(
                    session,
                    spec,
                    scenarioToken,
                    helperDigest,
                    helperPayloadDigest,
                    targetDigest,
                    scenarioResources);
            }

            profiles += execution.ProfileCreated ? 1 : 0;
            targets += execution.TargetCreated ? 1 : 0;
            if (spec.RecoveryPlanned)
            {
                if (recoverySupervisors >= Stage17WMaximumRecoverySupervisors)
                {
                    execution = execution with { Passed = false, Reason = "recovery-supervisor-cap-exhausted" };
                }
                else
                {
                    recoverySupervisors++;
                    bool recovered = RunRecoverySupervisor(closure, supervisorImage, scenarioToken);
                    execution = execution with { RecoverySupervisorRan = true, RecoveryConfirmed = recovered };
                    if (!recovered)
                    {
                        execution = execution with { Passed = false, Reason = "recovery-unconfirmed" };
                    }
                }
            }

            LifecycleResidueScan after = WaitForZeroLifecycleResidue(helperImage, resources);
            bool passed = execution.Passed && after.IsZero;
            scenarioResults.Add(new Stage17WScenarioResult(
                Index: index + 1,
                Code: spec.Code,
                Status: passed ? "passed" : "failed",
                Reason: passed ? "scenario-passed" : execution.Reason,
                ExpectedPhaseObserved: execution.ExpectedPhaseObserved,
                ProfileCreated: execution.ProfileCreated,
                HelperCreated: true,
                TargetCreated: execution.TargetCreated,
                TargetSuspendedObserved: execution.TargetSuspendedObserved,
                TargetReadyObserved: execution.TargetReadyObserved,
                TargetExitObserved: execution.TargetExitObserved,
                ControlDisconnected: execution.ControlDisconnected,
                HelperCancellationConfirmed: execution.HelperCancellationConfirmed,
                SupervisorTerminationConfirmed: execution.SupervisorTerminationConfirmed,
                RecoverySupervisorRan: execution.RecoverySupervisorRan,
                RecoveryConfirmed: execution.RecoveryConfirmed,
                CleanupConfirmed: after.IsZero,
                Residue: after));
            if (!passed)
            {
                stoppedAfterFailure = true;
            }
        }

        LifecycleResidueScan finalScan = WaitForZeroLifecycleResidue(helperImage, resources);
        int processCount = 1 + initialSupervisors + recoverySupervisors + helpers + targets + controls;
        bool capsRespected =
            scenarioResults.Count <= 8 &&
            profiles <= 8 &&
            initialSupervisors <= 8 &&
            recoverySupervisors <= Stage17WMaximumRecoverySupervisors &&
            initialSupervisors + recoverySupervisors <= Stage17WMaximumSupervisors &&
            helpers <= Stage17WMaximumHelpers &&
            targets <= Stage17WMaximumTargets &&
            controls <= Stage17WMaximumControls &&
            processCount <= Stage17WMaximumProcesses;
        bool passedAll =
            !stoppedAfterFailure &&
            scenarioResults.Count == 8 &&
            scenarioResults.All(static result => result.Status == "passed") &&
            profiles == 8 &&
            initialSupervisors == 8 &&
            recoverySupervisors == 4 &&
            helpers == 8 &&
            targets == 6 &&
            controls == 2 &&
            processCount == 29 &&
            capsRespected &&
            finalScan.IsZero;

        string receiptMaterial = string.Join(
            '|',
            runToken,
            closure.DigestOf(Stage17WSupervisorName),
            helperDigest,
            targetDigest,
            initialSupervisors.ToString(CultureInfo.InvariantCulture),
            recoverySupervisors.ToString(CultureInfo.InvariantCulture),
            helpers.ToString(CultureInfo.InvariantCulture),
            targets.ToString(CultureInfo.InvariantCulture),
            controls.ToString(CultureInfo.InvariantCulture),
            string.Join(',', scenarioResults.Select(static item => $"{item.Code}:{item.Status}")));
        string receiptFingerprint = Convert.ToHexString(
            SHA256.HashData(Encoding.UTF8.GetBytes(receiptMaterial))).ToLowerInvariant();

        return new Stage17WProofResult(
            SchemaVersion: 1,
            ProtocolVersion: ProtocolVersion,
            Status: passedAll ? "passed" : "failed",
            Reason: passedAll ? "stage17w-lifecycle-proof-passed" : "stage17w-lifecycle-proof-failed",
            RunToken: runToken,
            CandidateId: RuntimeClosureLease.CandidateId,
            InstalledRootFingerprint: Fingerprint(closure.Root),
            SupervisorSha256: closure.DigestOf(Stage17WSupervisorName),
            HelperSha256: helperDigest,
            HelperPayloadSha256: helperPayloadDigest,
            TargetSha256: targetDigest,
            ClosureHandleCount: closure.RetainedHandleCount,
            ScenarioAttempts: scenarioResults.Count,
            Profiles: profiles,
            InitialSupervisors: initialSupervisors,
            RecoverySupervisors: recoverySupervisors,
            SupervisorsTotal: initialSupervisors + recoverySupervisors,
            Helpers: helpers,
            AppContainerTargets: targets,
            OrdinaryControlTargets: controls,
            AllProofCreatedProcesses: processCount,
            CapsRespected: capsRespected,
            StoppedAfterFailure: stoppedAfterFailure,
            Scenarios: scenarioResults,
            FinalResidue: finalScan,
            ReceiptFingerprint: receiptFingerprint,
            ProductionEligible: false);
    }

    private static Stage17WScenarioExecution RunOneStage17WScenario(
        ControllerSession session,
        Stage17WScenario spec,
        string scenarioToken,
        string helperDigest,
        string helperPayloadDigest,
        string targetDigest,
        LifecycleResources resources)
    {
        bool profile = false;
        bool target = false;
        bool suspended = false;
        bool ready = false;
        bool exited = false;
        bool disconnect = false;
        bool helperCancelled = false;
        bool supervisorTerminated = false;
        bool expectedObserved = false;
        string reason = "scenario-incomplete";
        try
        {
            session.Send(new LifecycleRequestFrame(
                SchemaVersion: 1,
                ProtocolVersion: ProtocolVersion,
                Command: "run-lifecycle-scenario",
                Scenario: spec.Code,
                Token: scenarioToken,
                HelperSha256: helperDigest,
                HelperPayloadSha256: helperPayloadDigest,
                FixtureSha256: targetDigest));
            session.ReadCheckpoint("request-accepted");
            LifecycleCheckpointFrame setup = session.ReadCheckpoint("setup-complete");
            profile = setup.ProfileCreated;
            resources.TryResolveProfileFolder();

            if (spec.Code == "control-disconnect-before-target")
            {
                expectedObserved = true;
                disconnect = true;
                session.DisconnectControl();
                bool observed = session.WaitForExit(7);
                return new Stage17WScenarioExecution(
                    observed, observed ? "control-disconnect-failed-closed" : "control-disconnect-exit-unconfirmed",
                    true, profile, false, false, false, false, true, false, false, false, false);
            }

            if (spec.Code == "helper-terminated-after-setup")
            {
                expectedObserved = true;
                helperCancelled = session.CancelHelper("setup-complete");
                session.AcknowledgeCancellation();
                bool observed = session.WaitForExit(17);
                return new Stage17WScenarioExecution(
                    helperCancelled && observed,
                    helperCancelled && observed ? "helper-cancelled-after-setup" : "helper-cancellation-unconfirmed",
                    true, profile, false, false, false, false, false, helperCancelled, false, false, false);
            }

            LifecycleCheckpointFrame suspendedFrame = session.ContinueAndRead("setup-complete", "target-suspended");
            target = suspendedFrame.TargetCreated;
            suspended = suspendedFrame.TargetSuspended;
            if (spec.ExpectedPhase == "target-suspended")
            {
                expectedObserved = true;
                if (spec.Code == "helper-terminated-target-suspended")
                {
                    helperCancelled = session.CancelHelper("target-suspended");
                    session.AcknowledgeCancellation();
                    bool observed = session.WaitForExit(17);
                    return new Stage17WScenarioExecution(
                        helperCancelled && observed,
                        helperCancelled && observed ? "helper-cancelled-while-suspended" : "helper-cancellation-unconfirmed",
                        true, profile, target, suspended, false, false, false, helperCancelled, false, false, false);
                }

                supervisorTerminated = session.TerminateSupervisor();
                return new Stage17WScenarioExecution(
                    supervisorTerminated,
                    supervisorTerminated ? "supervisor-terminated-while-suspended" : "supervisor-termination-unconfirmed",
                    true, profile, target, suspended, false, false, false, false, supervisorTerminated, false, false);
            }

            LifecycleCheckpointFrame readyFrame = session.ContinueAndRead("target-suspended", "target-ready");
            ready = readyFrame.TargetReady;
            if (spec.ExpectedPhase == "target-ready")
            {
                expectedObserved = true;
                if (spec.Code == "supervisor-helper-terminated-target-running")
                {
                    helperCancelled = session.CancelHelper("target-ready");
                    supervisorTerminated = session.TerminateSupervisor();
                    return new Stage17WScenarioExecution(
                        helperCancelled && supervisorTerminated,
                        helperCancelled && supervisorTerminated ? "supervisor-and-helper-terminated" : "combined-termination-unconfirmed",
                        true, profile, target, suspended, ready, false, false, helperCancelled, supervisorTerminated, false, false);
                }

                supervisorTerminated = session.TerminateSupervisor();
                return new Stage17WScenarioExecution(
                    supervisorTerminated,
                    supervisorTerminated ? "supervisor-terminated-after-ready" : "supervisor-termination-unconfirmed",
                    true, profile, target, suspended, ready, false, false, false, supervisorTerminated, false, false);
            }

            LifecycleCheckpointFrame exitFrame = session.ContinueAndRead("target-ready", "target-exited");
            exited = exitFrame.TargetExited;
            if (spec.ExpectedPhase == "target-exited")
            {
                expectedObserved = true;
                supervisorTerminated = session.TerminateSupervisor();
                return new Stage17WScenarioExecution(
                    supervisorTerminated,
                    supervisorTerminated ? "supervisor-terminated-after-target-exit" : "supervisor-termination-unconfirmed",
                    true, profile, target, suspended, ready, exited, false, false, supervisorTerminated, false, false);
            }

            LifecycleCheckpointFrame cleanup = session.ContinueAndRead("target-exited", "cleanup-complete");
            expectedObserved = cleanup.CleanupConfirmed;
            bool normalExit = session.WaitForExit(0);
            reason = normalExit && cleanup.CleanupConfirmed ? "normal-lifecycle-complete" : "normal-lifecycle-unconfirmed";
            return new Stage17WScenarioExecution(
                normalExit && cleanup.CleanupConfirmed,
                reason,
                expectedObserved,
                profile,
                target,
                suspended,
                ready,
                exited,
                disconnect,
                helperCancelled,
                supervisorTerminated,
                false,
                false);
        }
        catch (Exception exception) when (!IsFatal(exception))
        {
            return new Stage17WScenarioExecution(
                false,
                reason,
                expectedObserved,
                profile,
                target,
                suspended,
                ready,
                exited,
                disconnect,
                helperCancelled,
                supervisorTerminated,
                false,
                false);
        }
    }

    internal static Stage17WEgressResult RunStage17WEgress(
        string runToken,
        ReviewedProofAuthorization authorization)
    {
        if (!MutationGate.Authorized(authorization) || !LifecycleTokenPattern().IsMatch(runToken))
        {
            return Stage17WEgressResult.Refused(runToken);
        }

        using RuntimeClosureLease closure =
            RuntimeClosureLease.AcquireInstalled(
                runToken,
                Stage17WSupervisorName,
                Stage17WRuntimeSourceEnvelopeFingerprint);
        string supervisorImage = closure.AuthorizeImage(Stage17WSupervisorName);
        string[] providers = ["anthropic", "openai"];
        List<Stage17WEgressProviderResult> results = [];
        foreach (string provider in providers)
        {
            using ControllerSession session =
                ControllerSession.Launch(closure, supervisorImage, "egress-relay");
            session.Send(new
            {
                schemaVersion = 1,
                protocolVersion = ProtocolVersion,
                command = "provider-egress-canary",
                provider,
            });
            byte[] response = session.ReadRaw();
            results.Add(ParseStage17WEgressResponse(provider, response));
            if (!session.WaitForExit(0))
            {
                results[^1] = results[^1] with
                {
                    Status = "failed",
                    Code = "relay-exit-unconfirmed",
                };
            }
        }

        bool passed = results.Count == 2 && results.All(result => result.Status == "passed");
        string material = JsonSerializer.Serialize(new
        {
            schemaVersion = 1,
            runToken,
            providers = results,
            supervisorSha256 = closure.DigestOf(Stage17WSupervisorName),
        });
        string receipt = Convert.ToHexString(
            SHA256.HashData(Encoding.UTF8.GetBytes(material))).ToLowerInvariant();
        return new Stage17WEgressResult(
            SchemaVersion: 1,
            Status: passed ? "passed" : "failed",
            Reason: passed ? "controlled-provider-egress-passed" : "controlled-provider-egress-failed",
            RunToken: runToken,
            CandidateId: RuntimeClosureLease.CandidateId,
            SupervisorSha256: closure.DigestOf(Stage17WSupervisorName),
            Providers: results,
            ExactDestinationCount: 2,
            ProxyEnabled: false,
            RedirectsFollowed: false,
            QuicEnabled: false,
            CredentialsUsed: false,
            RequestBodyBytes: 0,
            ReceiptFingerprint: receipt,
            ProductionEligible: false);
    }

    private static Stage17WEgressProviderResult ParseStage17WEgressResponse(
        string expectedProvider,
        byte[] payload)
    {
        try
        {
            using JsonDocument document = JsonDocument.Parse(payload);
            JsonElement root = document.RootElement;
            string[] names = root.EnumerateObject().Select(property => property.Name)
                .OrderBy(name => name, StringComparer.Ordinal).ToArray();
            string[] expected =
            [
                "code", "credentialsUsed", "endpointFingerprint", "protocolVersion", "provider",
                "proxyEnabled", "quicEnabled", "redirectObserved", "requestBodyBytes",
                "schemaVersion", "status",
            ];
            Array.Sort(expected, StringComparer.Ordinal);
            string fingerprint = root.GetProperty("endpointFingerprint").GetString() ?? string.Empty;
            bool valid = names.SequenceEqual(expected, StringComparer.Ordinal) &&
                root.GetProperty("schemaVersion").GetInt32() == 1 &&
                root.GetProperty("protocolVersion").GetInt32() == ProtocolVersion &&
                string.Equals(root.GetProperty("status").GetString(), "passed", StringComparison.Ordinal) &&
                string.Equals(root.GetProperty("code").GetString(), "provider-endpoint-reached", StringComparison.Ordinal) &&
                string.Equals(root.GetProperty("provider").GetString(), expectedProvider, StringComparison.Ordinal) &&
                BoundarySha256Pattern().IsMatch(fingerprint) &&
                string.Equals(
                    fingerprint,
                    ExpectedStage17WEgressFingerprint(expectedProvider),
                    StringComparison.Ordinal) &&
                !root.GetProperty("redirectObserved").GetBoolean() &&
                !root.GetProperty("proxyEnabled").GetBoolean() &&
                !root.GetProperty("quicEnabled").GetBoolean() &&
                !root.GetProperty("credentialsUsed").GetBoolean() &&
                root.GetProperty("requestBodyBytes").GetInt32() == 0;
            return new Stage17WEgressProviderResult(
                expectedProvider,
                valid ? "passed" : "failed",
                valid ? "provider-endpoint-reached" : "relay-response-invalid",
                valid ? fingerprint : string.Empty);
        }
        catch (Exception exception) when (!IsFatal(exception))
        {
            return new Stage17WEgressProviderResult(
                expectedProvider,
                "failed",
                "relay-response-invalid",
                string.Empty);
        }
    }

    private static string ExpectedStage17WEgressFingerprint(string provider)
    {
        string endpoint = provider switch
        {
            "anthropic" => Stage17WAnthropicEgressEndpoint,
            "openai" => Stage17WOpenAiEgressEndpoint,
            _ => throw new ProofException("controller-egress-provider-unreviewed"),
        };
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(endpoint)))
            .ToLowerInvariant();
    }

    private sealed class ControllerSession : IDisposable
    {
        private nint processHandle;
        private nint requestWriteHandle;
        private nint responseReadHandle;
        private bool disposed;

        private ControllerSession(nint processHandle, nint requestWriteHandle, nint responseReadHandle)
        {
            this.processHandle = processHandle;
            this.requestWriteHandle = requestWriteHandle;
            this.responseReadHandle = responseReadHandle;
        }

        internal static ControllerSession Launch(
            RuntimeClosureLease closure,
            string supervisorImage,
            string commandName = "run-session")
        {
            if (commandName is not ("run-session" or "egress-relay"))
            {
                throw new ProofException("controller-supervisor-command-refused");
            }
            nint process = 0;
            nint thread = 0;
            nint requestRead = 0;
            nint requestWrite = 0;
            nint responseRead = 0;
            nint responseWrite = 0;
            nint nullHandle = 0;
            nint attributeList = 0;
            nint handleList = 0;
            nint environment = 0;
            bool initialized = false;
            var inheritable = new SecurityAttributes
            {
                Length = checked((uint)Marshal.SizeOf<SecurityAttributes>()),
                InheritHandle = true,
            };

            try
            {
                EnsureWin32(CreatePipe(out requestRead, out requestWrite, ref inheritable, LifecycleMaximumFrameBytes), "controller-request-pipe-failed");
                EnsureWin32(SetHandleInformation(requestWrite, HandleFlagInherit, 0), "controller-request-handle-failed");
                EnsureWin32(CreatePipe(out responseRead, out responseWrite, ref inheritable, LifecycleMaximumFrameBytes), "controller-response-pipe-failed");
                EnsureWin32(SetHandleInformation(responseRead, HandleFlagInherit, 0), "controller-response-handle-failed");
                nullHandle = CreateFileW(
                    "NUL",
                    GenericRead | LifecycleGenericWrite,
                    FileShareRead | FileShareWrite,
                    ref inheritable,
                    OpenExisting,
                    0,
                    0);
                EnsureHandle(nullHandle, "controller-null-handle-failed");
                InitializeControllerHandleList(
                    [requestRead, responseWrite, nullHandle],
                    out attributeList,
                    out initialized,
                    out handleList);
                environment = CreateLifecycleHelperEnvironment();
                closure.AssertOpen();
                string command = string.Join(
                    ' ',
                    QuoteWindowsArgument(supervisorImage),
                    commandName,
                    requestRead.ToInt64().ToString(CultureInfo.InvariantCulture),
                    responseWrite.ToInt64().ToString(CultureInfo.InvariantCulture));
                char[] writable = (command + '\0').ToCharArray();
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
                EnsureWin32(CreateProcessW(
                    supervisorImage,
                    writable,
                    0,
                    0,
                    inheritHandles: true,
                    CreateUnicodeEnvironment | ExtendedStartupInfoPresent | LifecycleCreateNoWindow,
                    environment,
                    closure.Root,
                    ref startup,
                    out ProcessInformation information),
                    "controller-supervisor-create-failed");
                process = information.Process;
                thread = information.Thread;
                var result = new ControllerSession(process, requestWrite, responseRead);
                process = 0;
                requestWrite = 0;
                responseRead = 0;
                return result;
            }
            finally
            {
                if (initialized)
                {
                    DeleteProcThreadAttributeList(attributeList);
                }

                FreeUnmanaged(ref attributeList);
                FreeUnmanaged(ref handleList);
                FreeUnmanaged(ref environment);
                CloseNativeHandle(ref thread);
                CloseNativeHandle(ref process);
                CloseNativeHandle(ref requestRead);
                CloseNativeHandle(ref requestWrite);
                CloseNativeHandle(ref responseRead);
                CloseNativeHandle(ref responseWrite);
                CloseNativeHandle(ref nullHandle);
            }
        }

        internal void Send<T>(T value) => WriteLifecycleFrame(requestWriteHandle, value);

        internal byte[] ReadRaw() =>
            ReadLifecycleFrame(responseReadHandle, LifecycleFrameTimeoutMilliseconds);

        internal LifecycleCheckpointFrame ReadCheckpoint(string phase)
        {
            LifecycleCheckpointFrame checkpoint = ReadLifecycleCheckpoint(responseReadHandle, phase);
            RequireLifecycleCheckpoint(checkpoint, phase);
            return checkpoint;
        }

        internal LifecycleCheckpointFrame ContinueAndRead(string fromPhase, string toPhase)
        {
            Send(new LifecycleControlFrame(1, ProtocolVersion, "continue", fromPhase));
            return ReadCheckpoint(toPhase);
        }

        internal bool CancelHelper(string phase)
        {
            Send(new LifecycleControlFrame(1, ProtocolVersion, "cancel", phase));
            byte[] acknowledgement = ReadLifecycleFrame(responseReadHandle, LifecycleFrameTimeoutMilliseconds);
            try
            {
                using JsonDocument document = JsonDocument.Parse(acknowledgement);
                JsonElement root = document.RootElement;
                return root.GetProperty("schemaVersion").GetInt32() == 1 &&
                    root.GetProperty("protocolVersion").GetInt32() == ProtocolVersion &&
                    string.Equals(root.GetProperty("status").GetString(), "cancelled", StringComparison.Ordinal) &&
                    string.Equals(root.GetProperty("phase").GetString(), "helper-terminated", StringComparison.Ordinal);
            }
            catch (JsonException)
            {
                return false;
            }
        }

        internal void AcknowledgeCancellation() =>
            Send(new LifecycleControlFrame(1, ProtocolVersion, "continue", "helper-terminated"));

        internal void DisconnectControl() => CloseNativeHandle(ref requestWriteHandle);

        internal bool TerminateSupervisor()
        {
            bool terminated = TerminateProcess(processHandle, Stage17WInjectedSupervisorExitCode);
            bool observed = terminated &&
                WaitForSingleObject(processHandle, LifecycleHelperWaitMilliseconds) == WaitObject0 &&
                GetExitCodeProcess(processHandle, out uint code) &&
                code == Stage17WInjectedSupervisorExitCode;
            CloseNativeHandle(ref requestWriteHandle);
            CloseNativeHandle(ref responseReadHandle);
            return observed;
        }

        internal bool WaitForExit(uint expectedCode)
        {
            if (WaitForSingleObject(processHandle, LifecycleHelperWaitMilliseconds) != WaitObject0 ||
                !GetExitCodeProcess(processHandle, out uint code))
            {
                return false;
            }

            return code == expectedCode;
        }

        public void Dispose()
        {
            if (disposed)
            {
                return;
            }

            disposed = true;
            CloseNativeHandle(ref requestWriteHandle);
            CloseNativeHandle(ref responseReadHandle);
            CloseNativeHandle(ref processHandle);
        }
    }

    private static bool RunOrdinaryControl(
        RuntimeClosureLease closure,
        string targetImage,
        string runToken,
        int controlIndex)
    {
        string temp = Path.TrimEndingDirectorySeparator(Path.GetFullPath(Path.GetTempPath()));
        string marker = Path.Combine(temp, $"stage17-runtime-control-{runToken}-{controlIndex.ToString(CultureInfo.InvariantCulture)}.marker");
        nint process = 0;
        nint thread = 0;
        nint environment = 0;
        try
        {
            if (File.Exists(marker))
            {
                return false;
            }

            environment = CreateLifecycleHelperEnvironment();
            closure.AssertOpen();
            char[] command = ($"{QuoteWindowsArgument(targetImage)} ordinary-control {QuoteWindowsArgument(marker)}\0").ToCharArray();
            var startup = new StartupInfoEx
            {
                StartupInfo = new StartupInfo { Cb = checked((uint)Marshal.SizeOf<StartupInfo>()) },
            };
            EnsureWin32(CreateProcessW(
                targetImage,
                command,
                0,
                0,
                inheritHandles: false,
                CreateUnicodeEnvironment | LifecycleCreateNoWindow,
                environment,
                closure.Root,
                ref startup,
                out ProcessInformation information),
                "ordinary-control-create-failed");
            process = information.Process;
            thread = information.Thread;
            bool passed =
                WaitForSingleObject(process, LifecycleTargetWaitMilliseconds) == WaitObject0 &&
                GetExitCodeProcess(process, out uint code) &&
                code == 0 &&
                File.Exists(marker) &&
                string.Equals(File.ReadAllText(marker), "stage17-ordinary-control-v1", StringComparison.Ordinal);
            if (File.Exists(marker))
            {
                File.Delete(marker);
            }

            return passed && !File.Exists(marker);
        }
        finally
        {
            FreeUnmanaged(ref environment);
            CloseNativeHandle(ref thread);
            CloseNativeHandle(ref process);
        }
    }

    private static bool RunRecoverySupervisor(
        RuntimeClosureLease closure,
        string supervisorImage,
        string scenarioToken)
    {
        nint process = 0;
        nint thread = 0;
        nint environment = 0;
        nint nullHandle = 0;
        nint attributes = 0;
        nint handleList = 0;
        bool initialized = false;
        var inheritable = new SecurityAttributes
        {
            Length = checked((uint)Marshal.SizeOf<SecurityAttributes>()),
            InheritHandle = true,
        };
        try
        {
            nullHandle = CreateFileW(
                "NUL",
                GenericRead | LifecycleGenericWrite,
                FileShareRead | FileShareWrite,
                ref inheritable,
                OpenExisting,
                0,
                0);
            EnsureHandle(nullHandle, "recovery-null-handle-failed");
            InitializeControllerHandleList([nullHandle], out attributes, out initialized, out handleList);
            environment = CreateLifecycleHelperEnvironment();
            closure.AssertOpen();
            char[] command = ($"{QuoteWindowsArgument(supervisorImage)} recover {scenarioToken}\0").ToCharArray();
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
                AttributeList = attributes,
            };
            EnsureWin32(CreateProcessW(
                supervisorImage,
                command,
                0,
                0,
                inheritHandles: true,
                CreateUnicodeEnvironment | ExtendedStartupInfoPresent | LifecycleCreateNoWindow,
                environment,
                closure.Root,
                ref startup,
                out ProcessInformation information),
                "recovery-supervisor-create-failed");
            process = information.Process;
            thread = information.Thread;
            return
                WaitForSingleObject(process, LifecycleHelperWaitMilliseconds) == WaitObject0 &&
                GetExitCodeProcess(process, out uint code) &&
                code == 0;
        }
        catch (Exception exception) when (!IsFatal(exception))
        {
            return false;
        }
        finally
        {
            if (initialized)
            {
                DeleteProcThreadAttributeList(attributes);
            }

            FreeUnmanaged(ref attributes);
            FreeUnmanaged(ref handleList);
            FreeUnmanaged(ref environment);
            CloseNativeHandle(ref thread);
            CloseNativeHandle(ref process);
            CloseNativeHandle(ref nullHandle);
        }
    }

    private static void InitializeControllerHandleList(
        nint[] handles,
        out nint attributes,
        out bool initialized,
        out nint handleList)
    {
        attributes = 0;
        initialized = false;
        handleList = 0;
        nuint size = 0;
        _ = InitializeProcThreadAttributeList(0, 1, 0, ref size);
        if (size == 0)
        {
            throw new ProofException("controller-attribute-size-failed");
        }

        attributes = Marshal.AllocHGlobal(checked((int)size));
        EnsureWin32(InitializeProcThreadAttributeList(attributes, 1, 0, ref size), "controller-attributes-failed");
        initialized = true;
        handleList = Marshal.AllocHGlobal(checked(handles.Length * nint.Size));
        for (int index = 0; index < handles.Length; index++)
        {
            Marshal.WriteIntPtr(handleList, checked(index * nint.Size), handles[index]);
        }

        EnsureWin32(UpdateProcThreadAttribute(
            attributes,
            0,
            ProcThreadAttributeHandleList,
            handleList,
            checked((nuint)(handles.Length * nint.Size)),
            0,
            0),
            "controller-handle-list-failed");
    }

    private static LifecycleResidueScan WaitForZeroLifecycleResidue(
        string helperImage,
        IReadOnlyList<LifecycleResources> resources)
    {
        LifecycleResidueScan scan = ScanLifecycleResidue(helperImage, resources);
        for (int attempt = 0; attempt < CleanupObservationAttempts && !scan.IsZero; attempt++)
        {
            Thread.Sleep(CleanupObservationDelayMs);
            scan = ScanLifecycleResidue(helperImage, resources);
        }

        return scan;
    }

    private static string DeriveStage17WScenarioToken(string runToken, int index)
        => RuntimeClosureLease.DeriveScenarioToken(runToken, index);

    private static bool IsLowerHexCharacter(char character) =>
        character is (>= '0' and <= '9') or (>= 'a' and <= 'f');

    private sealed record Stage17WScenario(string Code, string ExpectedPhase, bool RecoveryPlanned);
}

internal sealed record Stage17WPlan(
    int SchemaVersion,
    string Status,
    string CandidateId,
    string RunToken,
    int ScenarioAttempts,
    int MaximumProfiles,
    int MaximumInitialSupervisors,
    int MaximumRecoverySupervisors,
    int MaximumSupervisors,
    int MaximumHelpers,
    int MaximumTargets,
    int MaximumOrdinaryControls,
    int MaximumProcesses,
    IReadOnlyList<Stage17WPlanScenario> Scenarios)
{
    internal static Stage17WPlan Refused { get; } = new(
        1, "refused", RuntimeClosureLease.CandidateId, string.Empty,
        0, 8, 8, 4, 12, 8, 6, 2, 30, []);
}

internal sealed record Stage17WPlanScenario(
    int Index,
    string Code,
    string ScenarioToken,
    string ProfileName,
    string StagingLeaf,
    string CanaryLeaf,
    bool RecoverySupervisorPlanned);

internal sealed record Stage17WScenarioExecution(
    bool Passed,
    string Reason,
    bool ExpectedPhaseObserved,
    bool ProfileCreated,
    bool TargetCreated,
    bool TargetSuspendedObserved,
    bool TargetReadyObserved,
    bool TargetExitObserved,
    bool ControlDisconnected,
    bool HelperCancellationConfirmed,
    bool SupervisorTerminationConfirmed,
    bool RecoverySupervisorRan,
    bool RecoveryConfirmed);

internal sealed record Stage17WScenarioResult(
    int Index,
    string Code,
    string Status,
    string Reason,
    bool ExpectedPhaseObserved,
    bool ProfileCreated,
    bool HelperCreated,
    bool TargetCreated,
    bool TargetSuspendedObserved,
    bool TargetReadyObserved,
    bool TargetExitObserved,
    bool ControlDisconnected,
    bool HelperCancellationConfirmed,
    bool SupervisorTerminationConfirmed,
    bool RecoverySupervisorRan,
    bool RecoveryConfirmed,
    bool CleanupConfirmed,
    LifecycleResidueScan Residue)
{
    internal static Stage17WScenarioResult Failed(int index, string code, string reason) =>
        new(index, code, "failed", reason, false, false, false, false, false,
            false, false, false, false, false, false, false, false,
            LifecycleResidueScan.NotRun);
}

internal sealed record Stage17WProofResult(
    int SchemaVersion,
    int ProtocolVersion,
    string Status,
    string Reason,
    string RunToken,
    string CandidateId,
    string InstalledRootFingerprint,
    string SupervisorSha256,
    string HelperSha256,
    string HelperPayloadSha256,
    string TargetSha256,
    int ClosureHandleCount,
    int ScenarioAttempts,
    int Profiles,
    int InitialSupervisors,
    int RecoverySupervisors,
    int SupervisorsTotal,
    int Helpers,
    int AppContainerTargets,
    int OrdinaryControlTargets,
    int AllProofCreatedProcesses,
    bool CapsRespected,
    bool StoppedAfterFailure,
    IReadOnlyList<Stage17WScenarioResult> Scenarios,
    LifecycleResidueScan FinalResidue,
    string ReceiptFingerprint,
    bool ProductionEligible)
{
    internal static Stage17WProofResult Refused(string token) => new(
        1, 5, "refused", "proof-mode-not-authorized", token,
        RuntimeClosureLease.CandidateId, string.Empty, string.Empty, string.Empty,
        string.Empty, string.Empty, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        false, true, [], LifecycleResidueScan.NotRun, string.Empty, false);
}

internal sealed record Stage17WEgressProviderResult(
    string Provider,
    string Status,
    string Code,
    string EndpointFingerprint);

internal sealed record Stage17WEgressResult(
    int SchemaVersion,
    string Status,
    string Reason,
    string RunToken,
    string CandidateId,
    string SupervisorSha256,
    IReadOnlyList<Stage17WEgressProviderResult> Providers,
    int ExactDestinationCount,
    bool ProxyEnabled,
    bool RedirectsFollowed,
    bool QuicEnabled,
    bool CredentialsUsed,
    int RequestBodyBytes,
    string ReceiptFingerprint,
    bool ProductionEligible)
{
    internal static Stage17WEgressResult Refused(string token) => new(
        1, "refused", "proof-mode-not-authorized", token,
        RuntimeClosureLease.CandidateId, string.Empty, [], 2, false, false,
        false, false, 0, string.Empty, false);
}

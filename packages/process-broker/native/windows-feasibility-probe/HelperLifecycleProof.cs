using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using System.Threading;

namespace AiDevOs.WindowsSandboxFeasibilityProbe;

internal static partial class AppContainerSyntheticProcessProof
{
    private const string LifecycleProfilePrefix = "AiDevOs.Stage17.HelperProof.";
    private const string LifecycleStagingPrefix = "ai-dev-os-stage17-helper-proof-";
    private const string LifecycleCanaryPrefix = "ai-dev-os-stage17-helper-canary-";
    private const string LifecycleFixtureFileName = "AI.DevOS.WindowsBoundaryFixture.exe";
    private const string LifecycleHelperFileName =
        "AI.DevOS.WindowsSandboxFeasibilityProbe.exe";
    private const string LifecycleHelperPayloadFileName =
        "AI.DevOS.WindowsSandboxFeasibilityProbe.dll";
    private const string LifecycleAllowedContent = "stage17-helper-lifecycle-allowed-v1";
    private const string LifecycleCanaryContent = "stage17-helper-lifecycle-canary-v1";
    private const int LifecycleMaximumFrameBytes = 4_096;
    private const int LifecycleFrameTimeoutMilliseconds = 30_000;
    private const int LifecycleFixtureHoldMilliseconds = 4_000;
    private const uint LifecycleHelperWaitMilliseconds = 45_000;
    private const uint LifecycleTargetWaitMilliseconds = 10_000;
    private const uint LifecycleCreateNoWindow = 0x08000000;
    private const uint LifecycleGenericWrite = 0x40000000;
    private const int LifecycleErrorBrokenPipe = 109;
    private const int LifecycleErrorNoData = 232;
    private const uint LifecycleInjectedHelperExitCode = 17;
    private const int LifecycleChannelClosedExitCode = 7;
    private const int LifecycleWorkerFailureExitCode = 8;
    private const int LifecycleProfileCreationLimit = 10;
    private const int LifecycleFixtureCreationLimit = 10;
    private const int LifecycleTotalProcessCreationLimit = 20;

    private static readonly UTF8Encoding LifecycleUtf8 = new(
        encoderShouldEmitUTF8Identifier: false,
        throwOnInvalidBytes: true);

    private static readonly JsonSerializerOptions LifecycleJsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        WriteIndented = false,
    };

    private static readonly LifecycleScenarioSpec[] LifecycleScenarioSpecs =
    [
        new("normal-lifecycle", "normal", "cleanup-complete"),
        new("client-disconnect-before-target", "disconnect", "setup-complete"),
        new("helper-terminated-after-setup", "terminate-helper", "setup-complete"),
        new("helper-terminated-target-suspended", "terminate-helper", "target-suspended"),
        new("helper-terminated-target-running", "terminate-helper", "target-ready"),
        new("helper-terminated-after-target-exit", "terminate-helper", "target-exited"),
    ];

    public static HelperLifecycleCrashProofResult RunHelperLifecycleCrashProof(
        string helperSource,
        string expectedHelperSha256,
        string expectedHelperPayloadSha256,
        string fixtureSource,
        string expectedFixtureSha256,
        string priorProfileCreateCountText,
        string priorHelperProcessCreateCountText,
        string priorFixtureProcessCreateCountText,
        string priorOtherTaskProcessCreateCountText)
    {
        int priorProfileCreateCount = ParseLifecyclePriorCount(
            priorProfileCreateCountText,
            LifecycleProfileCreationLimit);
        int priorHelperProcessCreateCount = ParseLifecyclePriorCount(
            priorHelperProcessCreateCountText,
            LifecycleTotalProcessCreationLimit);
        int priorFixtureProcessCreateCount = ParseLifecyclePriorCount(
            priorFixtureProcessCreateCountText,
            LifecycleFixtureCreationLimit);
        int priorOtherTaskProcessCreateCount = ParseLifecyclePriorCount(
            priorOtherTaskProcessCreateCountText,
            LifecycleTotalProcessCreationLimit);
        string canonicalHelper = ValidateLifecycleExecutable(
            helperSource,
            expectedHelperSha256,
            LifecycleHelperFileName,
            "invalid-lifecycle-helper");
        string canonicalFixture = ValidateLifecycleExecutable(
            fixtureSource,
            expectedFixtureSha256,
            LifecycleFixtureFileName,
            "invalid-lifecycle-fixture");
        string helperPayload = Path.Combine(
            Path.GetDirectoryName(canonicalHelper) ??
                throw new ProofException("lifecycle-helper-parent-unavailable"),
            LifecycleHelperPayloadFileName);
        _ = ValidateLifecycleExecutable(
            helperPayload,
            expectedHelperPayloadSha256,
            LifecycleHelperPayloadFileName,
            "invalid-lifecycle-helper-payload");
        string currentImage = Path.GetFullPath(
            Environment.ProcessPath ??
            throw new ProofException("lifecycle-current-image-unavailable"));
        if (
            !string.Equals(currentImage, canonicalHelper, StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(
                Path.GetDirectoryName(canonicalHelper),
                Path.GetDirectoryName(canonicalFixture),
                StringComparison.OrdinalIgnoreCase))
        {
            throw new ProofException("lifecycle-executable-layout-invalid");
        }

        var scenarioResults = new List<HelperLifecycleScenarioResult>(
            LifecycleScenarioSpecs.Length);
        var resources = new List<LifecycleResources>(LifecycleScenarioSpecs.Length);
        int profileCreateCount = priorProfileCreateCount;
        int helperProcessCreateCount = priorHelperProcessCreateCount;
        int fixtureProcessCreateCount = priorFixtureProcessCreateCount;
        bool stoppedAfterFailure = false;
        bool manualRecoveryRequired = false;

        foreach (LifecycleScenarioSpec spec in LifecycleScenarioSpecs)
        {
            if (
                profileCreateCount >= LifecycleProfileCreationLimit ||
                fixtureProcessCreateCount >= LifecycleFixtureCreationLimit ||
                checked(helperProcessCreateCount + fixtureProcessCreateCount) >=
                    checked(
                        LifecycleTotalProcessCreationLimit -
                        priorOtherTaskProcessCreateCount))
            {
                stoppedAfterFailure = true;
                break;
            }

            string token = Convert.ToHexString(RandomNumberGenerator.GetBytes(16))
                .ToLowerInvariant();
            LifecycleResources scenarioResources = LifecycleResources.Create(token);
            resources.Add(scenarioResources);
            HelperLifecycleScenarioResult result = RunLifecycleScenario(
                spec,
                scenarioResources,
                canonicalHelper,
                expectedHelperSha256,
                expectedHelperPayloadSha256,
                expectedFixtureSha256);
            scenarioResults.Add(result);
            helperProcessCreateCount = checked(
                helperProcessCreateCount + (result.HelperProcessCreated ? 1 : 0));
            profileCreateCount = checked(
                profileCreateCount + (result.ProfileCreated ? 1 : 0));
            fixtureProcessCreateCount = checked(
                fixtureProcessCreateCount + (result.FixtureProcessCreated ? 1 : 0));
            manualRecoveryRequired |= result.ManualRecoveryRequired;
            if (result.Status != "passed")
            {
                stoppedAfterFailure = true;
                break;
            }
        }

        LifecycleResidueScan finalScan = ScanLifecycleResidue(
            canonicalHelper,
            resources);
        bool capsRespected =
            profileCreateCount <= LifecycleProfileCreationLimit &&
            fixtureProcessCreateCount <= LifecycleFixtureCreationLimit &&
            checked(helperProcessCreateCount + fixtureProcessCreateCount) <=
                checked(
                    LifecycleTotalProcessCreationLimit -
                    priorOtherTaskProcessCreateCount);
        bool passed =
            !stoppedAfterFailure &&
            scenarioResults.Count == LifecycleScenarioSpecs.Length &&
            scenarioResults.All(static result => result.Status == "passed") &&
            profileCreateCount ==
                checked(priorProfileCreateCount + LifecycleScenarioSpecs.Length) &&
            helperProcessCreateCount ==
                checked(priorHelperProcessCreateCount + LifecycleScenarioSpecs.Length) &&
            fixtureProcessCreateCount == checked(priorFixtureProcessCreateCount + 4) &&
            capsRespected &&
            finalScan.IsZero;

        return new HelperLifecycleCrashProofResult(
            SchemaVersion: 1,
            ProtocolVersion: ProtocolVersion,
            Status: passed ? "passed" : "failed",
            Reason: passed
                ? "helper-lifecycle-crash-proof-passed"
                : "helper-lifecycle-crash-proof-failed",
            HelperSha256: expectedHelperSha256,
            HelperPayloadSha256: expectedHelperPayloadSha256,
            FixtureSha256: expectedFixtureSha256,
            MaximumFrameBytes: LifecycleMaximumFrameBytes,
            OneRequestPerHelper: true,
            InheritedAmbientEnvironment: false,
            ExplicitHelperHandleCount: 4,
            ProfileCreationLimit: LifecycleProfileCreationLimit,
            FixtureProcessCreationLimit: LifecycleFixtureCreationLimit,
            TotalTaskProcessCreationLimit: LifecycleTotalProcessCreationLimit,
            PriorProfileCreateCount: priorProfileCreateCount,
            PriorHelperProcessCreateCount: priorHelperProcessCreateCount,
            PriorFixtureProcessCreateCount: priorFixtureProcessCreateCount,
            PriorOtherTaskProcessCreateCount: priorOtherTaskProcessCreateCount,
            ProfileCreateCount: profileCreateCount,
            HelperProcessCreateCount: helperProcessCreateCount,
            FixtureProcessCreateCount: fixtureProcessCreateCount,
            TotalTaskProcessCreateCount: checked(
                helperProcessCreateCount +
                fixtureProcessCreateCount +
                priorOtherTaskProcessCreateCount),
            ScenarioCount: scenarioResults.Count,
            Scenarios: scenarioResults.ToArray(),
            FinalResidueScan: finalScan,
            CapsRespected: capsRespected,
            StoppedAfterFailure: stoppedAfterFailure,
            ManualRecoveryRequired: manualRecoveryRequired,
            ProductionBackendAvailable: false);
    }

    public static bool RunLifecycleProtocolSelfTest()
    {
        const string token = "0123456789abcdef0123456789abcdef";
        const string digest =
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        string valid = JsonSerializer.Serialize(
            new LifecycleRequestFrame(
                1,
                ProtocolVersion,
                "run-lifecycle-scenario",
                "normal-lifecycle",
                token,
                digest,
                digest,
                digest),
            LifecycleJsonOptions);
        string duplicate =
            $"{{\"schemaVersion\":1,\"schemaVersion\":1," +
            $"\"protocolVersion\":{ProtocolVersion}," +
            "\"command\":\"run-lifecycle-scenario\"," +
            "\"scenario\":\"normal-lifecycle\"," +
            $"\"token\":\"{token}\",\"helperSha256\":\"{digest}\"," +
            $"\"helperPayloadSha256\":\"{digest}\"," +
            $"\"fixtureSha256\":\"{digest}\"}}";
        string unknown = valid.Replace(
            "normal-lifecycle",
            "unknown-scenario",
            StringComparison.Ordinal);
        string control = JsonSerializer.Serialize(
            new LifecycleControlFrame(1, ProtocolVersion, "continue", "setup-complete"),
            LifecycleJsonOptions);
        LifecycleResources readOnlyResources = LifecycleResources.Create(token);

        return
            !Directory.Exists(readOnlyResources.StagingRoot) &&
            !Directory.Exists(readOnlyResources.CanaryRoot) &&
            TryParseLifecycleRequest(LifecycleUtf8.GetBytes(valid), out _) &&
            !TryParseLifecycleRequest(LifecycleUtf8.GetBytes("{"), out _) &&
            !TryParseLifecycleRequest(LifecycleUtf8.GetBytes(duplicate), out _) &&
            !TryParseLifecycleRequest(LifecycleUtf8.GetBytes(unknown), out _) &&
            IsLifecycleFrameLengthValid(LifecycleMaximumFrameBytes) &&
            !IsLifecycleFrameLengthValid(LifecycleMaximumFrameBytes + 1) &&
            TryParseLifecycleControl(
                LifecycleUtf8.GetBytes(control),
                "setup-complete",
                out _) &&
            !TryParseLifecycleControl(
                LifecycleUtf8.GetBytes(control),
                "target-suspended",
                out _);
    }

    public static int RunLifecycleWorker(
        string requestReadHandleText,
        string responseWriteHandleText,
        string jobHandleText)
    {
        nint requestReadHandle = 0;
        nint responseWriteHandle = 0;
        nint jobHandle = 0;
        LifecycleWorkerSession? session = null;
        bool channelClosed = false;
        bool refusalWritten = false;
        string terminalCode = "lifecycle-worker-failed";

        try
        {
            requestReadHandle = ParseLifecycleHandle(requestReadHandleText);
            responseWriteHandle = ParseLifecycleHandle(responseWriteHandleText);
            jobHandle = ParseLifecycleHandle(jobHandleText);
            if (
                requestReadHandle == responseWriteHandle ||
                requestReadHandle == jobHandle ||
                responseWriteHandle == jobHandle)
            {
                throw new ProofException("lifecycle-handle-alias-refused");
            }

            byte[] requestBytes = ReadLifecycleFrame(
                requestReadHandle,
                LifecycleFrameTimeoutMilliseconds);
            if (!TryParseLifecycleRequest(requestBytes, out LifecycleRequestFrame? request))
            {
                WriteLifecycleRefusal(responseWriteHandle, "invalid-request-frame");
                return LifecycleWorkerFailureExitCode;
            }

            LifecycleRequestFrame validatedRequest = request ??
                throw new LifecycleProtocolException("invalid-request-frame");

            string currentImage = Path.GetFullPath(
                Environment.ProcessPath ??
                throw new ProofException("lifecycle-current-image-unavailable"));
            _ = ValidateLifecycleExecutable(
                currentImage,
                validatedRequest.HelperSha256,
                LifecycleHelperFileName,
                "lifecycle-helper-identity-mismatch");
            _ = ValidateLifecycleExecutable(
                Path.Combine(
                    Path.GetDirectoryName(currentImage) ??
                        throw new ProofException("lifecycle-helper-parent-unavailable"),
                    LifecycleHelperPayloadFileName),
                validatedRequest.HelperPayloadSha256,
                LifecycleHelperPayloadFileName,
                "lifecycle-helper-payload-identity-mismatch");
            string fixtureSource = Path.Combine(
                Path.GetDirectoryName(currentImage) ??
                throw new ProofException("lifecycle-helper-parent-unavailable"),
                LifecycleFixtureFileName);
            _ = ValidateLifecycleExecutable(
                fixtureSource,
                validatedRequest.FixtureSha256,
                LifecycleFixtureFileName,
                "lifecycle-fixture-identity-mismatch");

            session = new LifecycleWorkerSession(validatedRequest, fixtureSource, jobHandle);
            WriteLifecycleCheckpoint(
                responseWriteHandle,
                session.CreateCheckpoint("request-accepted"));
            session.Setup();
            WriteLifecycleCheckpoint(
                responseWriteHandle,
                session.CreateCheckpoint("setup-complete"));
            if (!ReadLifecycleContinue(requestReadHandle, "setup-complete"))
            {
                channelClosed = true;
                terminalCode = "client-channel-closed";
                return LifecycleChannelClosedExitCode;
            }

            session.CreateTargetSuspended();
            WriteLifecycleCheckpoint(
                responseWriteHandle,
                session.CreateCheckpoint("target-suspended"));
            if (!ReadLifecycleContinue(requestReadHandle, "target-suspended"))
            {
                channelClosed = true;
                terminalCode = "client-channel-closed";
                return LifecycleChannelClosedExitCode;
            }

            session.ResumeAndObserveReady();
            WriteLifecycleCheckpoint(
                responseWriteHandle,
                session.CreateCheckpoint("target-ready"));
            if (!ReadLifecycleContinue(requestReadHandle, "target-ready"))
            {
                channelClosed = true;
                terminalCode = "client-channel-closed";
                return LifecycleChannelClosedExitCode;
            }

            session.ObserveTargetExit();
            WriteLifecycleCheckpoint(
                responseWriteHandle,
                session.CreateCheckpoint("target-exited"));
            if (!ReadLifecycleContinue(requestReadHandle, "target-exited"))
            {
                channelClosed = true;
                terminalCode = "client-channel-closed";
                return LifecycleChannelClosedExitCode;
            }

            terminalCode = "lifecycle-worker-complete";
        }
        catch (LifecycleChannelClosedException)
        {
            channelClosed = true;
            terminalCode = "client-channel-closed";
        }
        catch (LifecycleProtocolException exception)
        {
            terminalCode = exception.Code;
            refusalWritten = TryWriteLifecycleRefusal(responseWriteHandle, exception.Code);
        }
        catch (ProofException exception)
        {
            terminalCode = exception.Code;
            refusalWritten = TryWriteLifecycleRefusal(responseWriteHandle, exception.Code);
        }
        catch (Exception exception) when (!IsFatal(exception))
        {
            terminalCode = "lifecycle-worker-exception";
            refusalWritten = TryWriteLifecycleRefusal(responseWriteHandle, terminalCode);
        }
        finally
        {
            bool cleanupConfirmed = session?.Cleanup() ?? true;
            if (!channelClosed && responseWriteHandle != 0)
            {
                try
                {
                    if (
                        session is not null &&
                        terminalCode == "lifecycle-worker-complete")
                    {
                        WriteLifecycleCheckpoint(
                            responseWriteHandle,
                            session.CreateCheckpoint("cleanup-complete"));
                    }
                    else if (!refusalWritten)
                    {
                        refusalWritten = TryWriteLifecycleRefusal(
                            responseWriteHandle,
                            terminalCode);
                    }
                }
                catch (Exception exception) when (!IsFatal(exception))
                {
                    cleanupConfirmed = false;
                }
            }

            CloseNativeHandle(ref requestReadHandle);
            CloseNativeHandle(ref responseWriteHandle);
            CloseNativeHandle(ref jobHandle);
            if (!cleanupConfirmed)
            {
                terminalCode = "lifecycle-worker-cleanup-unconfirmed";
            }
        }

        return terminalCode == "lifecycle-worker-complete"
            ? 0
            : channelClosed
                ? LifecycleChannelClosedExitCode
                : LifecycleWorkerFailureExitCode;
    }

    private static HelperLifecycleScenarioResult RunLifecycleScenario(
        LifecycleScenarioSpec spec,
        LifecycleResources resources,
        string helperSource,
        string helperSha256,
        string helperPayloadSha256,
        string fixtureSha256)
    {
        nint jobHandle = 0;
        nint helperProcessHandle = 0;
        nint requestWriteHandle = 0;
        nint responseReadHandle = 0;
        bool helperProcessCreated = false;
        bool helperExitObserved = false;
        uint? helperExitCode = null;
        bool expectedPhaseObserved = false;
        bool clientDisconnected = false;
        bool helperTerminationInjected = false;
        bool helperTerminationHandleBased = false;
        bool profileCreated = false;
        bool fixtureProcessCreated = false;
        bool targetSuspended = false;
        bool targetReady = false;
        bool targetExited = false;
        bool markerObservedBeforeRecovery = false;
        bool markerAbsentBeforeResume = false;
        bool jobTerminationAttempted = false;
        bool jobTerminationSucceeded = false;
        bool jobDrained = false;
        uint? jobTotalProcesses = null;
        uint? jobActiveProcesses = null;
        bool helperOwnedCleanup = false;
        bool supervisorRecoveryPerformed = false;
        bool supervisorRecoveryConfirmed = false;
        bool manualRecoveryRequired = false;
        bool controllerHandlesClosed = false;
        string reason = "scenario-failed";
        int? nativeErrorCode = null;
        LifecycleResidueScan observedScan = LifecycleResidueScan.NotRun;
        LifecycleResidueScan postRecoveryScan = LifecycleResidueScan.NotRun;

        try
        {
            jobHandle = CreateLifecycleJob();
            LaunchLifecycleHelper(
                helperSource,
                helperSha256,
                helperPayloadSha256,
                jobHandle,
                out helperProcessHandle,
                out requestWriteHandle,
                out responseReadHandle);
            helperProcessCreated = true;
            WriteLifecycleFrame(
                requestWriteHandle,
                new LifecycleRequestFrame(
                    SchemaVersion: 1,
                    ProtocolVersion: ProtocolVersion,
                    Command: "run-lifecycle-scenario",
                    Scenario: spec.Code,
                    Token: resources.Token,
                    HelperSha256: helperSha256,
                    HelperPayloadSha256: helperPayloadSha256,
                    FixtureSha256: fixtureSha256));

            LifecycleCheckpointFrame accepted = ReadLifecycleCheckpoint(
                responseReadHandle,
                "request-accepted");
            RequireLifecycleCheckpoint(accepted, "request-accepted");

            LifecycleCheckpointFrame setup = ReadLifecycleCheckpoint(
                responseReadHandle,
                "setup-complete");
            RequireLifecycleCheckpoint(setup, "setup-complete");
            profileCreated = setup.ProfileCreated;
            resources.ResolveProfileFolder();
            markerAbsentBeforeResume = !File.Exists(resources.MarkerFile);

            if (spec.ExpectedPhase == "setup-complete")
            {
                expectedPhaseObserved = true;
                if (spec.Interruption == "disconnect")
                {
                    CloseNativeHandle(ref requestWriteHandle);
                    clientDisconnected = true;
                    helperExitObserved =
                        WaitForSingleObject(
                            helperProcessHandle,
                            LifecycleHelperWaitMilliseconds) == WaitObject0;
                }
                else
                {
                    helperTerminationInjected = true;
                    helperTerminationHandleBased = TerminateProcess(
                        helperProcessHandle,
                        LifecycleInjectedHelperExitCode);
                    helperExitObserved =
                        WaitForSingleObject(
                            helperProcessHandle,
                            LifecycleHelperWaitMilliseconds) == WaitObject0;
                }
            }
            else
            {
                WriteLifecycleControl(requestWriteHandle, "setup-complete");
                LifecycleCheckpointFrame suspended = ReadLifecycleCheckpoint(
                    responseReadHandle,
                    "target-suspended");
                RequireLifecycleCheckpoint(suspended, "target-suspended");
                fixtureProcessCreated = suspended.TargetCreated;
                targetSuspended = suspended.TargetSuspended;
                markerAbsentBeforeResume = !File.Exists(resources.MarkerFile);

                if (spec.ExpectedPhase == "target-suspended")
                {
                    expectedPhaseObserved = true;
                    helperTerminationInjected = true;
                    helperTerminationHandleBased = TerminateProcess(
                        helperProcessHandle,
                        LifecycleInjectedHelperExitCode);
                    helperExitObserved =
                        WaitForSingleObject(
                            helperProcessHandle,
                            LifecycleHelperWaitMilliseconds) == WaitObject0;
                }
                else
                {
                    WriteLifecycleControl(requestWriteHandle, "target-suspended");
                    LifecycleCheckpointFrame ready = ReadLifecycleCheckpoint(
                        responseReadHandle,
                        "target-ready");
                    RequireLifecycleCheckpoint(ready, "target-ready");
                    targetReady = ready.TargetReady;

                    if (spec.ExpectedPhase == "target-ready")
                    {
                        expectedPhaseObserved = true;
                        helperTerminationInjected = true;
                        helperTerminationHandleBased = TerminateProcess(
                            helperProcessHandle,
                            LifecycleInjectedHelperExitCode);
                        helperExitObserved =
                            WaitForSingleObject(
                                helperProcessHandle,
                                LifecycleHelperWaitMilliseconds) == WaitObject0;
                    }
                    else
                    {
                        WriteLifecycleControl(requestWriteHandle, "target-ready");
                        LifecycleCheckpointFrame exited = ReadLifecycleCheckpoint(
                            responseReadHandle,
                            "target-exited");
                        RequireLifecycleCheckpoint(exited, "target-exited");
                        targetExited = exited.TargetExited;

                        if (spec.ExpectedPhase == "target-exited")
                        {
                            expectedPhaseObserved = true;
                            helperTerminationInjected = true;
                            helperTerminationHandleBased = TerminateProcess(
                                helperProcessHandle,
                                LifecycleInjectedHelperExitCode);
                            helperExitObserved =
                                WaitForSingleObject(
                                    helperProcessHandle,
                                    LifecycleHelperWaitMilliseconds) == WaitObject0;
                        }
                        else
                        {
                            WriteLifecycleControl(requestWriteHandle, "target-exited");
                            LifecycleCheckpointFrame cleanup = ReadLifecycleCheckpoint(
                                responseReadHandle,
                                "cleanup-complete");
                            RequireLifecycleCheckpoint(cleanup, "cleanup-complete");
                            helperOwnedCleanup = cleanup.CleanupConfirmed;
                            expectedPhaseObserved = true;
                            helperExitObserved =
                                WaitForSingleObject(
                                    helperProcessHandle,
                                    LifecycleHelperWaitMilliseconds) == WaitObject0;
                        }
                    }
                }
            }

            if (helperExitObserved)
            {
                EnsureWin32(
                    GetExitCodeProcess(helperProcessHandle, out uint observedExitCode),
                    "lifecycle-helper-exit-query-failed");
                helperExitCode = observedExitCode;
            }

            if (spec.Interruption == "terminate-helper")
            {
                jobTerminationAttempted = true;
                jobTerminationSucceeded = TerminateJobObject(jobHandle, 1);
                _ = WaitForSingleObject(jobHandle, JobDrainWaitMilliseconds);
                JobObjectBasicAccountingInformation accounting = QueryJobAccounting(jobHandle);
                jobTotalProcesses = accounting.TotalProcesses;
                jobActiveProcesses = accounting.ActiveProcesses;
                jobDrained = accounting.ActiveProcesses == 0;
                markerObservedBeforeRecovery = File.Exists(resources.MarkerFile);
                supervisorRecoveryPerformed = true;
                supervisorRecoveryConfirmed = RecoverLifecycleResources(resources);
            }
            else
            {
                JobObjectBasicAccountingInformation accounting = QueryJobAccounting(jobHandle);
                jobTotalProcesses = accounting.TotalProcesses;
                jobActiveProcesses = accounting.ActiveProcesses;
                jobDrained = accounting.ActiveProcesses == 0;
                helperOwnedCleanup =
                    spec.Interruption == "disconnect"
                        ? helperExitObserved
                        : helperOwnedCleanup;
            }

            controllerHandlesClosed = CloseLifecycleControllerHandles(
                ref requestWriteHandle,
                ref responseReadHandle,
                ref helperProcessHandle,
                ref jobHandle);

            observedScan = ScanLifecycleResidue(helperSource, [resources]);
            if (!observedScan.IsZero && spec.Interruption != "terminate-helper")
            {
                manualRecoveryRequired = true;
                _ = RecoverLifecycleResources(resources);
                postRecoveryScan = ScanLifecycleResidue(helperSource, [resources]);
            }
            else
            {
                postRecoveryScan = observedScan;
            }

            bool markerExpectationPassed = spec.Code switch
            {
                "helper-terminated-target-suspended" =>
                    markerAbsentBeforeResume && !markerObservedBeforeRecovery,
                "helper-terminated-target-running" => markerObservedBeforeRecovery,
                _ => true,
            };
            bool expectedHelperExit = spec.Interruption switch
            {
                "normal" => helperExitCode == 0,
                "disconnect" => helperExitCode == LifecycleChannelClosedExitCode,
                "terminate-helper" =>
                    helperTerminationHandleBased &&
                    helperExitCode == LifecycleInjectedHelperExitCode,
                _ => false,
            };
            bool cleanupPassed = spec.Interruption == "terminate-helper"
                ? supervisorRecoveryPerformed && supervisorRecoveryConfirmed
                : helperOwnedCleanup;
            bool noDescendantProcessSurvived =
                jobActiveProcesses == 0 &&
                jobTotalProcesses == (fixtureProcessCreated ? 1u : 0u);
            bool passed =
                expectedPhaseObserved &&
                helperProcessCreated &&
                profileCreated &&
                helperExitObserved &&
                expectedHelperExit &&
                markerExpectationPassed &&
                jobDrained &&
                noDescendantProcessSurvived &&
                cleanupPassed &&
                controllerHandlesClosed &&
                observedScan.IsZero &&
                !manualRecoveryRequired;
            reason = passed ? "scenario-passed" : "scenario-observation-failed";
        }
        catch (ProofException exception)
        {
            reason = exception.Code;
            nativeErrorCode = exception.NativeErrorCode;
        }
        catch (LifecycleProtocolException exception)
        {
            reason = exception.Code;
        }
        catch (Exception exception) when (!IsFatal(exception))
        {
            reason = "scenario-exception";
        }
        finally
        {
            if (helperProcessHandle != 0)
            {
                if (WaitForSingleObject(helperProcessHandle, 0) != WaitObject0)
                {
                    manualRecoveryRequired = true;
                    _ = TerminateProcess(
                        helperProcessHandle,
                        LifecycleInjectedHelperExitCode);
                    _ = WaitForSingleObject(
                        helperProcessHandle,
                        LifecycleHelperWaitMilliseconds);
                }
            }

            if (jobHandle != 0)
            {
                _ = TerminateJobObject(jobHandle, 1);
                _ = WaitForSingleObject(jobHandle, JobDrainWaitMilliseconds);
            }

            controllerHandlesClosed = CloseLifecycleControllerHandles(
                ref requestWriteHandle,
                ref responseReadHandle,
                ref helperProcessHandle,
                ref jobHandle);

            if (reason != "scenario-passed")
            {
                manualRecoveryRequired = true;
                _ = RecoverLifecycleResources(resources);
                postRecoveryScan = ScanLifecycleResidue(helperSource, [resources]);
            }
        }

        return new HelperLifecycleScenarioResult(
            SchemaVersion: 1,
            Scenario: spec.Code,
            Status: reason == "scenario-passed" ? "passed" : "failed",
            Reason: reason,
            NativeErrorCode: nativeErrorCode,
            ProfileNameFingerprint: Fingerprint(resources.ProfileName),
            ProfileSidFingerprint: Fingerprint(resources.ProfileSid),
            StagingRootFingerprint: Fingerprint(resources.StagingRoot),
            CanaryRootFingerprint: Fingerprint(resources.CanaryRoot),
            ExpectedPhase: spec.ExpectedPhase,
            ExpectedPhaseObserved: expectedPhaseObserved,
            ClientDisconnected: clientDisconnected,
            HelperTerminationInjected: helperTerminationInjected,
            HelperTerminationHandleBased: helperTerminationHandleBased,
            HelperProcessCreated: helperProcessCreated,
            HelperExitObserved: helperExitObserved,
            HelperExitCode: helperExitCode,
            ProfileCreated: profileCreated,
            FixtureProcessCreated: fixtureProcessCreated,
            TargetSuspended: targetSuspended,
            TargetReady: targetReady,
            TargetExited: targetExited,
            MarkerAbsentBeforeResume: markerAbsentBeforeResume,
            MarkerObservedBeforeRecovery: markerObservedBeforeRecovery,
            JobTerminationAttempted: jobTerminationAttempted,
            JobTerminationSucceeded: jobTerminationSucceeded,
            JobDrained: jobDrained,
            JobTotalProcesses: jobTotalProcesses,
            JobActiveProcesses: jobActiveProcesses,
            NoDescendantProcessSurvived:
                jobActiveProcesses == 0 &&
                jobTotalProcesses == (fixtureProcessCreated ? 1u : 0u),
            HelperOwnedCleanup: helperOwnedCleanup,
            SupervisorRecoveryPerformed: supervisorRecoveryPerformed,
            SupervisorRecoveryConfirmed: supervisorRecoveryConfirmed,
            ControllerHandlesClosed: controllerHandlesClosed,
            IndependentResidueScan: observedScan,
            ManualRecoveryRequired: manualRecoveryRequired,
            PostRecoveryResidueScan: postRecoveryScan);
    }

    private static bool CloseLifecycleControllerHandles(
        ref nint requestWriteHandle,
        ref nint responseReadHandle,
        ref nint helperProcessHandle,
        ref nint jobHandle)
    {
        bool closed = CloseLifecycleHandle(ref requestWriteHandle);
        closed &= CloseLifecycleHandle(ref responseReadHandle);
        closed &= CloseLifecycleHandle(ref helperProcessHandle);
        closed &= CloseLifecycleHandle(ref jobHandle);
        return closed;
    }

    private static bool CloseLifecycleHandle(ref nint handle)
    {
        if (handle == 0 || handle == new nint(-1))
        {
            handle = 0;
            return true;
        }

        bool closed = CloseHandle(handle);
        if (closed)
        {
            handle = 0;
        }

        return closed;
    }

    private static nint CreateLifecycleJob()
    {
        nint jobHandle = CreateJobObjectW(0, null);
        EnsureHandle(jobHandle, "lifecycle-job-create-failed");
        try
        {
            var limits = new JobObjectExtendedLimitInformation
            {
                BasicLimitInformation = new JobObjectBasicLimitInformation
                {
                    LimitFlags = JobObjectLimitKillOnJobClose | JobObjectLimitActiveProcess,
                    ActiveProcessLimit = 1,
                },
            };
            EnsureWin32(
                SetInformationJobObject(
                    jobHandle,
                    JobObjectExtendedLimitInformationClass,
                    ref limits,
                    checked((uint)Marshal.SizeOf<JobObjectExtendedLimitInformation>())),
                "lifecycle-job-configure-failed");
            return jobHandle;
        }
        catch
        {
            CloseNativeHandle(ref jobHandle);
            throw;
        }
    }

    private static void LaunchLifecycleHelper(
        string helperSource,
        string helperSha256,
        string helperPayloadSha256,
        nint jobHandle,
        out nint helperProcessHandle,
        out nint requestWriteHandle,
        out nint responseReadHandle)
    {
        helperProcessHandle = 0;
        requestWriteHandle = 0;
        responseReadHandle = 0;
        nint helperThreadHandle = 0;
        nint helperRequestReadHandle = 0;
        nint helperResponseWriteHandle = 0;
        nint nullHandle = 0;
        nint attributeList = 0;
        nint handleListPointer = 0;
        nint environmentPointer = 0;
        bool attributeListInitialized = false;
        bool jobInheritanceEnabled = false;
        var inheritable = new SecurityAttributes
        {
            Length = checked((uint)Marshal.SizeOf<SecurityAttributes>()),
            InheritHandle = true,
        };

        try
        {
            EnsureWin32(
                CreatePipe(
                    out helperRequestReadHandle,
                    out requestWriteHandle,
                    ref inheritable,
                    LifecycleMaximumFrameBytes),
                "lifecycle-request-pipe-create-failed");
            EnsureWin32(
                SetHandleInformation(requestWriteHandle, HandleFlagInherit, 0),
                "lifecycle-request-write-inheritance-clear-failed");
            EnsureWin32(
                CreatePipe(
                    out responseReadHandle,
                    out helperResponseWriteHandle,
                    ref inheritable,
                    LifecycleMaximumFrameBytes),
                "lifecycle-response-pipe-create-failed");
            EnsureWin32(
                SetHandleInformation(responseReadHandle, HandleFlagInherit, 0),
                "lifecycle-response-read-inheritance-clear-failed");

            nullHandle = CreateFileW(
                "NUL",
                GenericRead | LifecycleGenericWrite,
                FileShareRead | FileShareWrite,
                ref inheritable,
                OpenExisting,
                0,
                0);
            EnsureHandle(nullHandle, "lifecycle-null-handle-create-failed");
            EnsureWin32(
                SetHandleInformation(jobHandle, HandleFlagInherit, HandleFlagInherit),
                "lifecycle-job-inheritance-enable-failed");
            jobInheritanceEnabled = true;

            InitializeLifecycleHelperAttributeList(
                helperRequestReadHandle,
                helperResponseWriteHandle,
                jobHandle,
                nullHandle,
                out attributeList,
                out attributeListInitialized,
                out handleListPointer);
            environmentPointer = CreateLifecycleHelperEnvironment();

            string canonicalHelper = ValidateLifecycleExecutable(
                helperSource,
                helperSha256,
                LifecycleHelperFileName,
                "lifecycle-helper-prelaunch-identity-mismatch");
            _ = ValidateLifecycleExecutable(
                Path.Combine(
                    Path.GetDirectoryName(canonicalHelper) ??
                        throw new ProofException("lifecycle-helper-parent-unavailable"),
                    LifecycleHelperPayloadFileName),
                helperPayloadSha256,
                LifecycleHelperPayloadFileName,
                "lifecycle-helper-payload-prelaunch-identity-mismatch");
            string commandLineText = string.Join(
                ' ',
                QuoteWindowsArgument(canonicalHelper),
                "helper-lifecycle-worker",
                helperRequestReadHandle.ToInt64().ToString(CultureInfo.InvariantCulture),
                helperResponseWriteHandle.ToInt64().ToString(CultureInfo.InvariantCulture),
                jobHandle.ToInt64().ToString(CultureInfo.InvariantCulture));
            char[] commandLine = (commandLineText + '\0').ToCharArray();
            var startupInfo = new StartupInfoEx
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

            EnsureWin32(
                CreateProcessW(
                    canonicalHelper,
                    commandLine,
                    0,
                    0,
                    inheritHandles: true,
                    CreateUnicodeEnvironment |
                        ExtendedStartupInfoPresent |
                        LifecycleCreateNoWindow,
                    environmentPointer,
                    Path.GetDirectoryName(canonicalHelper) ??
                        throw new ProofException("lifecycle-helper-parent-unavailable"),
                    ref startupInfo,
                    out ProcessInformation processInformation),
                "lifecycle-helper-process-create-failed");
            helperProcessHandle = processInformation.Process;
            helperThreadHandle = processInformation.Thread;
        }
        finally
        {
            if (jobInheritanceEnabled)
            {
                _ = SetHandleInformation(jobHandle, HandleFlagInherit, 0);
            }

            if (attributeListInitialized)
            {
                DeleteProcThreadAttributeList(attributeList);
            }

            FreeUnmanaged(ref attributeList);
            FreeUnmanaged(ref handleListPointer);
            FreeUnmanaged(ref environmentPointer);
            CloseNativeHandle(ref helperThreadHandle);
            CloseNativeHandle(ref helperRequestReadHandle);
            CloseNativeHandle(ref helperResponseWriteHandle);
            CloseNativeHandle(ref nullHandle);

            if (helperProcessHandle == 0)
            {
                CloseNativeHandle(ref requestWriteHandle);
                CloseNativeHandle(ref responseReadHandle);
            }
        }
    }

    private static void InitializeLifecycleHelperAttributeList(
        nint requestReadHandle,
        nint responseWriteHandle,
        nint jobHandle,
        nint nullHandle,
        out nint attributeList,
        out bool attributeListInitialized,
        out nint handleListPointer)
    {
        attributeList = 0;
        attributeListInitialized = false;
        handleListPointer = 0;
        nuint attributeListSize = 0;
        _ = InitializeProcThreadAttributeList(0, 1, 0, ref attributeListSize);
        if (attributeListSize == 0)
        {
            throw new ProofException(
                "lifecycle-helper-attribute-size-query-failed",
                Marshal.GetLastWin32Error());
        }

        attributeList = Marshal.AllocHGlobal(checked((int)attributeListSize));
        EnsureWin32(
            InitializeProcThreadAttributeList(
                attributeList,
                1,
                0,
                ref attributeListSize),
            "lifecycle-helper-attribute-initialize-failed");
        attributeListInitialized = true;

        nint[] handles =
        [
            requestReadHandle,
            responseWriteHandle,
            jobHandle,
            nullHandle,
        ];
        handleListPointer = Marshal.AllocHGlobal(checked(handles.Length * nint.Size));
        for (int index = 0; index < handles.Length; index++)
        {
            Marshal.WriteIntPtr(
                handleListPointer,
                checked(index * nint.Size),
                handles[index]);
        }

        EnsureWin32(
            UpdateProcThreadAttribute(
                attributeList,
                0,
                ProcThreadAttributeHandleList,
                handleListPointer,
                checked((nuint)(handles.Length * nint.Size)),
                0,
                0),
            "lifecycle-helper-handle-list-update-failed");
    }

    private static nint CreateLifecycleHelperEnvironment()
    {
        string systemRoot = Path.GetFullPath(
            Environment.GetFolderPath(Environment.SpecialFolder.Windows));
        string systemDrive = Path.TrimEndingDirectorySeparator(
            Path.GetPathRoot(systemRoot) ??
            throw new ProofException("lifecycle-system-drive-unavailable"));
        string tempRoot = Path.TrimEndingDirectorySeparator(
            Path.GetFullPath(Path.GetTempPath()));
        string block = string.Join(
            '\0',
            "COMPlus_EnableDiagnostics=0",
            "DOTNET_EnableDiagnostics=0",
            "DOTNET_NOLOGO=1",
            $"SystemDrive={systemDrive}",
            $"SystemRoot={systemRoot}",
            $"TEMP={tempRoot}",
            $"TMP={tempRoot}",
            $"WINDIR={systemRoot}") + '\0';
        return Marshal.StringToHGlobalUni(block);
    }

    private sealed class LifecycleWorkerSession
    {
        private readonly LifecycleRequestFrame request;
        private readonly string fixtureSource;
        private readonly nint jobHandle;
        private readonly LifecycleResources resources;
        private nint profileSidPointer;
        private nint standardInputHandle;
        private nint standardOutputReadHandle;
        private nint standardOutputWriteHandle;
        private nint processHandle;
        private nint threadHandle;
        private nint processTokenHandle;
        private nint attributeList;
        private nint securityCapabilitiesPointer;
        private nint jobListPointer;
        private nint handleListPointer;
        private nint environmentPointer;
        private bool attributeListInitialized;
        private bool cleanupAttempted;

        internal LifecycleWorkerSession(
            LifecycleRequestFrame request,
            string fixtureSource,
            nint jobHandle)
        {
            if (!IsKnownLifecycleScenario(request.Scenario))
            {
                throw new ProofException("unknown-lifecycle-scenario");
            }

            this.request = request;
            this.fixtureSource = fixtureSource;
            this.jobHandle = jobHandle;
            resources = LifecycleResources.Create(request.Token);
        }

        internal bool ProfileCreated { get; private set; }

        internal bool StagingCreated { get; private set; }

        internal bool CanaryCreated { get; private set; }

        internal bool FixtureStaged { get; private set; }

        internal bool TargetCreated { get; private set; }

        internal bool TargetSuspended { get; private set; }

        internal bool TokenVerified { get; private set; }

        internal bool JobVerified { get; private set; }

        internal bool TargetReady { get; private set; }

        internal bool TargetExited { get; private set; }

        internal bool CleanupConfirmed { get; private set; }

        internal void Setup()
        {
            if (
                Directory.Exists(resources.StagingRoot) ||
                Directory.Exists(resources.CanaryRoot) ||
                RegistryKeyExists(MappingRegistryPath(resources.ProfileSid)) ||
                RegistryKeyExists(StorageRegistryPath(resources.ProfileName)))
            {
                throw new ProofException("preexisting-lifecycle-state");
            }

            DirectoryInfo stagingDirectory = Directory.CreateDirectory(
                resources.StagingRoot);
            StagingCreated = true;
            DirectoryInfo canaryDirectory = Directory.CreateDirectory(
                resources.CanaryRoot);
            CanaryCreated = true;

            int createResult = CreateAppContainerProfile(
                resources.ProfileName,
                "AI Development OS Stage 17 helper lifecycle proof",
                "Bounded helper crash cleanup feasibility proof",
                0,
                0,
                out profileSidPointer);
            if (createResult != 0 || profileSidPointer == 0)
            {
                throw new ProofException("lifecycle-profile-create-failed", createResult);
            }

            ProfileCreated = true;
            string returnedSid = new SecurityIdentifier(profileSidPointer).Value;
            if (!string.Equals(
                returnedSid,
                resources.ProfileSid,
                StringComparison.Ordinal))
            {
                throw new ProofException("lifecycle-profile-sid-mismatch");
            }

            resources.ResolveProfileFolder();

            var appContainerSid = new SecurityIdentifier(resources.ProfileSid);
            GrantStagingAccess(stagingDirectory, appContainerSid);
            if (!HasAllowRule(
                stagingDirectory.GetAccessControl(AccessControlSections.Access),
                appContainerSid,
                requireExplicit: true))
            {
                throw new ProofException("lifecycle-staging-acl-observation-failed");
            }

            DirectoryInfo markerDirectory = Directory.CreateDirectory(
                resources.MarkerRoot);
            GrantLifecycleMarkerAccess(markerDirectory, appContainerSid);
            if (!HasLifecycleMarkerWriteRule(markerDirectory, appContainerSid))
            {
                throw new ProofException("lifecycle-marker-acl-observation-failed");
            }

            ConfigureCanaryAcl(canaryDirectory);
            File.WriteAllText(
                resources.CanaryFile,
                LifecycleCanaryContent,
                Encoding.UTF8);
            DirectorySecurity canarySecurity = canaryDirectory.GetAccessControl(
                AccessControlSections.Access);
            if (
                !canarySecurity.AreAccessRulesProtected ||
                HasAnyRule(canarySecurity, appContainerSid))
            {
                throw new ProofException("lifecycle-canary-acl-observation-failed");
            }

            _ = ValidateLifecycleExecutable(
                fixtureSource,
                request.FixtureSha256,
                LifecycleFixtureFileName,
                "lifecycle-fixture-prestage-identity-mismatch");
            File.Copy(fixtureSource, resources.StagedFixture, overwrite: false);
            File.WriteAllText(
                resources.AllowedFile,
                LifecycleAllowedContent,
                Encoding.UTF8);
            if (
                HasReparsePoint(resources.StagedFixture) ||
                !string.Equals(
                    HashFile(resources.StagedFixture),
                    request.FixtureSha256,
                    StringComparison.Ordinal))
            {
                throw new ProofException("lifecycle-staged-fixture-identity-mismatch");
            }

            FixtureStaged = true;
        }

        internal void CreateTargetSuspended()
        {
            JobObjectBasicAccountingInformation initialAccounting =
                QueryJobAccounting(jobHandle);
            if (initialAccounting.ActiveProcesses != 0)
            {
                throw new ProofException("lifecycle-job-not-empty-before-target");
            }

            _ = ValidateLifecycleExecutable(
                fixtureSource,
                request.FixtureSha256,
                LifecycleFixtureFileName,
                "lifecycle-fixture-prelaunch-source-mismatch");
            if (
                HasReparsePoint(resources.StagedFixture) ||
                !string.Equals(
                    HashFile(resources.StagedFixture),
                    request.FixtureSha256,
                    StringComparison.Ordinal))
            {
                throw new ProofException("lifecycle-fixture-prelaunch-stage-mismatch");
            }

            CreateRestrictedStandardHandles(
                out standardInputHandle,
                out standardOutputReadHandle,
                out standardOutputWriteHandle);
            InitializeAttributeList(
                profileSidPointer,
                jobHandle,
                standardInputHandle,
                standardOutputWriteHandle,
                out attributeList,
                out attributeListInitialized,
                out securityCapabilitiesPointer,
                out jobListPointer,
                out handleListPointer);
            environmentPointer = CreateLifecycleTargetEnvironment(
                resources.StagedFixture,
                resources.ProfileFolder,
                resources.StagingRoot,
                resources.MarkerRoot);
            char[] commandLine = BuildLifecycleTargetCommandLine(resources);
            var startupInfo = new StartupInfoEx
            {
                StartupInfo = new StartupInfo
                {
                    Cb = checked((uint)Marshal.SizeOf<StartupInfoEx>()),
                    Flags = StartfUseStdHandles,
                    StandardInput = standardInputHandle,
                    StandardOutput = standardOutputWriteHandle,
                    StandardError = standardOutputWriteHandle,
                },
                AttributeList = attributeList,
            };

            bool created = CreateProcessW(
                resources.StagedFixture,
                commandLine,
                0,
                0,
                inheritHandles: true,
                CreateSuspended | CreateUnicodeEnvironment | ExtendedStartupInfoPresent,
                environmentPointer,
                resources.StagingRoot,
                ref startupInfo,
                out ProcessInformation processInformation);
            if (!created)
            {
                throw new ProofException(
                    "lifecycle-target-create-failed",
                    Marshal.GetLastWin32Error());
            }

            TargetCreated = true;
            TargetSuspended = true;
            processHandle = processInformation.Process;
            threadHandle = processInformation.Thread;
            CloseNativeHandle(ref standardOutputWriteHandle);

            EnsureWin32(
                OpenProcessToken(processHandle, TokenQuery, out processTokenHandle),
                "lifecycle-target-token-open-failed");
            bool appContainer = ReadTokenUInt32(
                processTokenHandle,
                TokenIsAppContainer,
                "lifecycle-target-token-query-failed") != 0;
            bool sidMatched = string.Equals(
                ReadTokenAppContainerSid(processTokenHandle),
                resources.ProfileSid,
                StringComparison.Ordinal);
            uint capabilityCount = ReadTokenGroupCount(
                processTokenHandle,
                TokenCapabilities,
                "lifecycle-target-capability-query-failed");
            TokenVerified = appContainer && sidMatched && capabilityCount == 0;
            EnsureWin32(
                IsProcessInJob(processHandle, jobHandle, out bool processInJob),
                "lifecycle-target-job-query-failed");
            JobObjectBasicAccountingInformation accounting = QueryJobAccounting(jobHandle);
            JobVerified = processInJob && accounting.ActiveProcesses == 1;
            if (!TokenVerified || !JobVerified)
            {
                throw new ProofException("lifecycle-target-boundary-observation-failed");
            }
        }

        internal void ResumeAndObserveReady()
        {
            uint previousSuspendCount = ResumeThread(threadHandle);
            if (previousSuspendCount != 1)
            {
                throw new ProofException(
                    "lifecycle-target-resume-failed",
                    previousSuspendCount == uint.MaxValue
                        ? Marshal.GetLastWin32Error()
                        : null);
            }

            TargetSuspended = false;
            string output = ReadLifecycleFixtureLine(standardOutputReadHandle);
            byte[] outputBytes = LifecycleUtf8.GetBytes(output);
            if (!TryParseLifecycleReady(outputBytes))
            {
                if (TryParseLifecycleFixtureFailure(outputBytes, out string? failureCode))
                {
                    throw new ProofException(
                        failureCode ?? "lifecycle-target-ready-frame-invalid");
                }

                throw new ProofException("lifecycle-target-ready-frame-invalid");
            }

            TargetReady = File.Exists(resources.MarkerFile);
            if (!TargetReady)
            {
                throw new ProofException("lifecycle-target-ready-marker-absent");
            }
        }

        internal void ObserveTargetExit()
        {
            uint waitResult = WaitForSingleObject(
                processHandle,
                LifecycleTargetWaitMilliseconds);
            if (waitResult != WaitObject0)
            {
                throw new ProofException(
                    waitResult == WaitTimeout
                        ? "lifecycle-target-exit-timeout"
                        : "lifecycle-target-exit-wait-failed",
                    waitResult == WaitTimeout ? null : Marshal.GetLastWin32Error());
            }

            EnsureWin32(
                GetExitCodeProcess(processHandle, out uint exitCode),
                "lifecycle-target-exit-query-failed");
            JobObjectBasicAccountingInformation accounting = QueryJobAccounting(jobHandle);
            TargetExited = exitCode == 0 && accounting.ActiveProcesses == 0;
            if (!TargetExited)
            {
                throw new ProofException("lifecycle-target-exit-observation-failed");
            }
        }

        internal LifecycleCheckpointFrame CreateCheckpoint(string phase) =>
            new(
                SchemaVersion: 1,
                ProtocolVersion: ProtocolVersion,
                Status: "checkpoint",
                Phase: phase,
                ProfileCreated: ProfileCreated,
                StagingCreated: StagingCreated,
                CanaryCreated: CanaryCreated,
                FixtureStaged: FixtureStaged,
                TargetCreated: TargetCreated,
                TargetSuspended: TargetSuspended,
                TokenVerified: TokenVerified,
                JobVerified: JobVerified,
                TargetReady: TargetReady,
                TargetExited: TargetExited,
                CleanupConfirmed: CleanupConfirmed);

        internal bool Cleanup()
        {
            if (cleanupAttempted)
            {
                return CleanupConfirmed;
            }

            cleanupAttempted = true;
            bool jobTerminated = true;
            bool jobDrained = true;
            try
            {
                jobTerminated = TerminateJobObject(jobHandle, 1);
                _ = WaitForSingleObject(jobHandle, JobDrainWaitMilliseconds);
                jobDrained = QueryJobAccounting(jobHandle).ActiveProcesses == 0;
            }
            catch (Exception exception) when (!IsFatal(exception))
            {
                jobTerminated = false;
                jobDrained = false;
            }

            if (attributeListInitialized)
            {
                DeleteProcThreadAttributeList(attributeList);
                attributeListInitialized = false;
            }

            FreeUnmanaged(ref attributeList);
            FreeUnmanaged(ref securityCapabilitiesPointer);
            FreeUnmanaged(ref jobListPointer);
            FreeUnmanaged(ref handleListPointer);
            FreeUnmanaged(ref environmentPointer);
            CloseNativeHandle(ref processTokenHandle);
            CloseNativeHandle(ref threadHandle);
            CloseNativeHandle(ref processHandle);
            CloseNativeHandle(ref standardOutputWriteHandle);
            CloseNativeHandle(ref standardOutputReadHandle);
            CloseNativeHandle(ref standardInputHandle);
            if (profileSidPointer != 0)
            {
                _ = FreeSid(profileSidPointer);
                profileSidPointer = 0;
            }

            bool filesRemoved = DeleteLifecycleFiles(resources);
            bool profileRemoved = DeleteLifecycleProfile(resources, ProfileCreated);
            CleanupConfirmed =
                jobTerminated &&
                jobDrained &&
                filesRemoved &&
                profileRemoved &&
                !Directory.Exists(resources.StagingRoot) &&
                !Directory.Exists(resources.CanaryRoot) &&
                (!resources.ProfileFolderResolved ||
                 !Directory.Exists(resources.ProfileFolder)) &&
                !RegistryKeyExists(MappingRegistryPath(resources.ProfileSid)) &&
                !RegistryKeyExists(StorageRegistryPath(resources.ProfileName));
            return CleanupConfirmed;
        }
    }

    private static char[] BuildLifecycleTargetCommandLine(LifecycleResources resources)
    {
        string commandLine = string.Join(
            ' ',
            QuoteWindowsArgument(resources.StagedFixture),
            "lifecycle-hold",
            QuoteWindowsArgument(resources.MarkerFile),
            LifecycleFixtureHoldMilliseconds.ToString(CultureInfo.InvariantCulture));
        return (commandLine + '\0').ToCharArray();
    }

    private static void GrantLifecycleMarkerAccess(
        DirectoryInfo directory,
        SecurityIdentifier appContainerSid)
    {
        DirectorySecurity security = directory.GetAccessControl(
            AccessControlSections.Access);
        security.AddAccessRule(
            new FileSystemAccessRule(
                appContainerSid,
                FileSystemRights.Modify,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
                PropagationFlags.None,
                AccessControlType.Allow));
        directory.SetAccessControl(security);
    }

    private static bool HasLifecycleMarkerWriteRule(
        DirectoryInfo directory,
        SecurityIdentifier appContainerSid)
    {
        AuthorizationRuleCollection rules = directory
            .GetAccessControl(AccessControlSections.Access)
            .GetAccessRules(
                includeExplicit: true,
                includeInherited: true,
                targetType: typeof(SecurityIdentifier));
        foreach (AuthorizationRule rule in rules)
        {
            if (
                rule is FileSystemAccessRule fileRule &&
                !fileRule.IsInherited &&
                fileRule.AccessControlType == AccessControlType.Allow &&
                fileRule.IdentityReference == appContainerSid &&
                (fileRule.FileSystemRights & FileSystemRights.Modify) ==
                    FileSystemRights.Modify)
            {
                return true;
            }
        }

        return false;
    }

    private static nint CreateLifecycleTargetEnvironment(
        string stagedFixture,
        string profileFolder,
        string stagingRoot,
        string markerRoot)
    {
        string systemRoot = Path.GetFullPath(
            Environment.GetFolderPath(Environment.SpecialFolder.Windows));
        string systemDrive = Path.TrimEndingDirectorySeparator(
            Path.GetPathRoot(systemRoot) ??
            throw new ProofException("system-drive-resolution-failed"));
        string stagingDrive = Path.TrimEndingDirectorySeparator(
            Path.GetPathRoot(stagingRoot) ??
            throw new ProofException("staging-drive-resolution-failed"));
        string block = string.Join(
            '\0',
            $"={stagingDrive}={stagingRoot}",
            $"COMSPEC={stagedFixture}",
            $"DOTNET_BUNDLE_EXTRACT_BASE_DIR={Path.Combine(profileFolder, "Bundle")}",
            $"LOCALAPPDATA={profileFolder}",
            $"SystemDrive={systemDrive}",
            $"SystemRoot={systemRoot}",
            $"TEMP={markerRoot}",
            $"TMP={markerRoot}",
            $"WINDIR={systemRoot}") + '\0';
        return Marshal.StringToHGlobalUni(block);
    }

    private static bool RecoverLifecycleResources(LifecycleResources resources)
    {
        resources.TryResolveProfileFolder();
        bool filesRemoved = DeleteLifecycleFiles(resources);
        bool profileRemoved = DeleteLifecycleProfile(resources, profileCreated: true);
        return
            filesRemoved &&
            profileRemoved &&
            !Directory.Exists(resources.StagingRoot) &&
            !Directory.Exists(resources.CanaryRoot) &&
            (!resources.ProfileFolderResolved ||
             !Directory.Exists(resources.ProfileFolder)) &&
            !RegistryKeyExists(MappingRegistryPath(resources.ProfileSid)) &&
            !RegistryKeyExists(StorageRegistryPath(resources.ProfileName));
    }

    private static bool DeleteLifecycleFiles(LifecycleResources resources)
    {
        try
        {
            DeleteLifecycleFile(resources.StagedFixture);
            DeleteLifecycleFile(resources.AllowedFile);
            DeleteLifecycleFile(resources.CanaryFile);
            DeleteLifecycleFile(resources.MarkerFile);
            DeleteLifecycleEmptyDirectory(resources.MarkerRoot);
            DeleteLifecycleEmptyDirectory(resources.StagingRoot);
            DeleteLifecycleEmptyDirectory(resources.CanaryRoot);
            return
                !File.Exists(resources.StagedFixture) &&
                !File.Exists(resources.AllowedFile) &&
                !File.Exists(resources.CanaryFile) &&
                !File.Exists(resources.MarkerFile) &&
                !Directory.Exists(resources.MarkerRoot) &&
                !Directory.Exists(resources.StagingRoot) &&
                !Directory.Exists(resources.CanaryRoot);
        }
        catch (Exception exception) when (!IsFatal(exception))
        {
            return false;
        }
    }

    private static void DeleteLifecycleFile(string path)
    {
        if (File.Exists(path))
        {
            File.Delete(path);
        }
    }

    private static void DeleteLifecycleEmptyDirectory(string path)
    {
        if (Directory.Exists(path))
        {
            var directory = new DirectoryInfo(path);
            if (!directory.EnumerateFileSystemInfos().Any())
            {
                Directory.Delete(path, recursive: false);
            }
        }
    }

    private static bool DeleteLifecycleProfile(
        LifecycleResources resources,
        bool profileCreated)
    {
        bool statePresent =
            profileCreated ||
            (resources.ProfileFolderResolved &&
             Directory.Exists(resources.ProfileFolder)) ||
            RegistryKeyExists(MappingRegistryPath(resources.ProfileSid)) ||
            RegistryKeyExists(StorageRegistryPath(resources.ProfileName));
        if (statePresent)
        {
            resources.TryResolveProfileFolder();
        }
        bool deleteSucceeded = !statePresent;
        if (statePresent)
        {
            deleteSucceeded = DeleteAppContainerProfile(resources.ProfileName) == 0;
            if (!deleteSucceeded)
            {
                Thread.Sleep(CleanupObservationDelayMs);
                deleteSucceeded = DeleteAppContainerProfile(resources.ProfileName) == 0;
            }
        }

        for (int attempt = 0; attempt < CleanupObservationAttempts; attempt++)
        {
            if (
                (!resources.ProfileFolderResolved ||
                 !Directory.Exists(resources.ProfileFolder)) &&
                !RegistryKeyExists(MappingRegistryPath(resources.ProfileSid)) &&
                !RegistryKeyExists(StorageRegistryPath(resources.ProfileName)))
            {
                return deleteSucceeded;
            }

            Thread.Sleep(CleanupObservationDelayMs);
        }

        return false;
    }

    private static LifecycleResidueScan ScanLifecycleResidue(
        string helperSource,
        IReadOnlyList<LifecycleResources> resources)
    {
        int filesystemResidueCount = 0;
        int markerResidueCount = 0;
        int packageFolderResidueCount = 0;
        int registryResidueCount = 0;
        var stagedImages = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (LifecycleResources item in resources)
        {
            stagedImages.Add(item.StagedFixture);
            filesystemResidueCount = checked(
                filesystemResidueCount +
                (Directory.Exists(item.StagingRoot) ? 1 : 0) +
                (Directory.Exists(item.CanaryRoot) ? 1 : 0) +
                (File.Exists(item.StagedFixture) ? 1 : 0) +
                (File.Exists(item.AllowedFile) ? 1 : 0) +
                (File.Exists(item.CanaryFile) ? 1 : 0));
            markerResidueCount = checked(
                markerResidueCount +
                (File.Exists(item.MarkerFile) ? 1 : 0) +
                (Directory.Exists(item.MarkerRoot) ? 1 : 0));
            packageFolderResidueCount = checked(
                packageFolderResidueCount +
                (item.ProfileFolderResolved && Directory.Exists(item.ProfileFolder) ? 1 : 0));
            registryResidueCount = checked(
                registryResidueCount +
                (RegistryKeyExists(MappingRegistryPath(item.ProfileSid)) ? 1 : 0) +
                (RegistryKeyExists(StorageRegistryPath(item.ProfileName)) ? 1 : 0));
        }

        string tempRoot = Path.TrimEndingDirectorySeparator(
            Path.GetFullPath(Path.GetTempPath()));
        int genericTaskDirectoryResidueCount = 0;
        foreach (string directory in Directory.EnumerateDirectories(tempRoot))
        {
            string name = Path.GetFileName(directory);
            if (
                LifecycleStagingDirectoryNamePattern().IsMatch(name) ||
                LifecycleCanaryDirectoryNamePattern().IsMatch(name))
            {
                genericTaskDirectoryResidueCount++;
            }
        }

        int genericRegistryResidueCount = CountGenericLifecycleRegistryResidue();
        int helperProcessResidueCount = 0;
        int fixtureProcessResidueCount = 0;
        int currentProcessId = Environment.ProcessId;
        foreach (Process process in Process.GetProcesses())
        {
            using (process)
            {
                try
                {
                    string? image = process.MainModule?.FileName;
                    if (image is null)
                    {
                        continue;
                    }

                    string canonicalImage = Path.GetFullPath(image);
                    if (
                        process.Id != currentProcessId &&
                        string.Equals(
                            canonicalImage,
                            helperSource,
                            StringComparison.OrdinalIgnoreCase))
                    {
                        helperProcessResidueCount++;
                    }

                    if (stagedImages.Contains(canonicalImage))
                    {
                        fixtureProcessResidueCount++;
                    }
                }
                catch (Exception exception) when (
                    exception is InvalidOperationException or
                        System.ComponentModel.Win32Exception or
                        NotSupportedException)
                {
                    // Inaccessible unrelated processes are outside the exact image set.
                }
            }
        }

        return new LifecycleResidueScan(
            FilesystemResidueCount: filesystemResidueCount,
            MarkerResidueCount: markerResidueCount,
            PackageFolderResidueCount: packageFolderResidueCount,
            RegistryResidueCount: registryResidueCount,
            HelperProcessResidueCount: helperProcessResidueCount,
            FixtureProcessResidueCount: fixtureProcessResidueCount,
            GenericTaskDirectoryResidueCount: genericTaskDirectoryResidueCount,
            GenericRegistryResidueCount: genericRegistryResidueCount);
    }

    private static int CountGenericLifecycleRegistryResidue()
    {
        int count = 0;
        using Microsoft.Win32.RegistryKey currentUser =
            Microsoft.Win32.RegistryKey.OpenBaseKey(
                Microsoft.Win32.RegistryHive.CurrentUser,
                Microsoft.Win32.RegistryView.Default);
        using Microsoft.Win32.RegistryKey? storage = currentUser.OpenSubKey(
            $@"{AppContainerRegistryRoot}\Storage",
            writable: false);
        if (storage is not null)
        {
            foreach (string name in storage.GetSubKeyNames())
            {
                if (name.StartsWith(LifecycleProfilePrefix, StringComparison.Ordinal))
                {
                    count++;
                }
            }
        }

        using Microsoft.Win32.RegistryKey? mappings = currentUser.OpenSubKey(
            $@"{AppContainerRegistryRoot}\Mappings",
            writable: false);
        if (mappings is not null)
        {
            foreach (string subkeyName in mappings.GetSubKeyNames())
            {
                using Microsoft.Win32.RegistryKey? mapping = mappings.OpenSubKey(
                    subkeyName,
                    writable: false);
                if (mapping is null)
                {
                    continue;
                }

                bool matched = false;
                foreach (string valueName in mapping.GetValueNames())
                {
                    if (
                        mapping.GetValue(valueName, null) is string value &&
                        value.StartsWith(LifecycleProfilePrefix, StringComparison.Ordinal))
                    {
                        matched = true;
                        break;
                    }
                }

                if (matched)
                {
                    count++;
                }
            }
        }

        return count;
    }

    private static LifecycleCheckpointFrame ReadLifecycleCheckpoint(
        nint responseReadHandle,
        string expectedPhase)
    {
        byte[] frame = ReadLifecycleFrame(
            responseReadHandle,
            LifecycleFrameTimeoutMilliseconds);
        if (TryParseLifecycleRefusal(frame, out LifecycleRefusalFrame? refusal))
        {
            throw new LifecycleProtocolException(
                refusal?.Code ?? "invalid-refusal-frame");
        }

        if (!TryParseLifecycleCheckpoint(frame, expectedPhase, out LifecycleCheckpointFrame? value))
        {
            throw new LifecycleProtocolException("invalid-checkpoint-frame");
        }

        return value ?? throw new LifecycleProtocolException("invalid-checkpoint-frame");
    }

    private static bool TryParseLifecycleRefusal(
        byte[] payload,
        out LifecycleRefusalFrame? refusal)
    {
        refusal = null;
        try
        {
            using JsonDocument document = JsonDocument.Parse(payload);
            if (!HasExactProperties(
                document.RootElement,
                ["schemaVersion", "protocolVersion", "status", "code"]))
            {
                return false;
            }

            LifecycleRefusalFrame? parsed =
                JsonSerializer.Deserialize<LifecycleRefusalFrame>(
                    payload,
                    LifecycleJsonOptions);
            if (parsed is not
                {
                    SchemaVersion: 1,
                    ProtocolVersion: ProtocolVersion,
                    Status: "refused",
                } ||
                !LifecycleStableCodePattern().IsMatch(parsed.Code))
            {
                return false;
            }

            refusal = parsed;
            return true;
        }
        catch (Exception exception) when (
            exception is JsonException or InvalidOperationException or NotSupportedException)
        {
            return false;
        }
    }

    private static void RequireLifecycleCheckpoint(
        LifecycleCheckpointFrame checkpoint,
        string expectedPhase)
    {
        bool valid = expectedPhase switch
        {
            "request-accepted" =>
                !checkpoint.ProfileCreated &&
                !checkpoint.TargetCreated &&
                !checkpoint.CleanupConfirmed,
            "setup-complete" =>
                checkpoint.ProfileCreated &&
                checkpoint.StagingCreated &&
                checkpoint.CanaryCreated &&
                checkpoint.FixtureStaged &&
                !checkpoint.TargetCreated &&
                !checkpoint.CleanupConfirmed,
            "target-suspended" =>
                checkpoint.ProfileCreated &&
                checkpoint.FixtureStaged &&
                checkpoint.TargetCreated &&
                checkpoint.TargetSuspended &&
                checkpoint.TokenVerified &&
                checkpoint.JobVerified &&
                !checkpoint.TargetReady &&
                !checkpoint.TargetExited,
            "target-ready" =>
                checkpoint.TargetCreated &&
                !checkpoint.TargetSuspended &&
                checkpoint.TokenVerified &&
                checkpoint.JobVerified &&
                checkpoint.TargetReady &&
                !checkpoint.TargetExited,
            "target-exited" =>
                checkpoint.TargetCreated &&
                checkpoint.TargetReady &&
                checkpoint.TargetExited &&
                !checkpoint.CleanupConfirmed,
            "cleanup-complete" => checkpoint.CleanupConfirmed,
            _ => false,
        };
        if (!valid)
        {
            throw new LifecycleProtocolException("checkpoint-observation-mismatch");
        }
    }

    private static bool ReadLifecycleContinue(nint requestReadHandle, string expectedPhase)
    {
        try
        {
            byte[] frame = ReadLifecycleFrame(
                requestReadHandle,
                LifecycleFrameTimeoutMilliseconds);
            if (!TryParseLifecycleControl(frame, expectedPhase, out _))
            {
                throw new LifecycleProtocolException("invalid-control-frame");
            }

            return true;
        }
        catch (LifecycleChannelClosedException)
        {
            return false;
        }
    }

    private static void WriteLifecycleControl(nint handle, string phase) =>
        WriteLifecycleFrame(
            handle,
            new LifecycleControlFrame(1, ProtocolVersion, "continue", phase));

    private static void WriteLifecycleCheckpoint(
        nint handle,
        LifecycleCheckpointFrame checkpoint) =>
        WriteLifecycleFrame(handle, checkpoint);

    private static void WriteLifecycleRefusal(nint handle, string code) =>
        WriteLifecycleFrame(
            handle,
            new LifecycleRefusalFrame(1, ProtocolVersion, "refused", code));

    private static bool TryWriteLifecycleRefusal(nint handle, string code)
    {
        if (handle == 0 || handle == new nint(-1))
        {
            return false;
        }

        try
        {
            WriteLifecycleRefusal(handle, code);
            return true;
        }
        catch (Exception exception) when (!IsFatal(exception))
        {
            // The caller still performs exact cleanup when the peer has gone away.
            return false;
        }
    }

    private static void WriteLifecycleFrame<T>(nint handle, T value)
    {
        byte[] payload = JsonSerializer.SerializeToUtf8Bytes(value, LifecycleJsonOptions);
        if (!IsLifecycleFrameLengthValid(payload.Length))
        {
            throw new LifecycleProtocolException("outbound-frame-too-large");
        }

        byte[] frame = new byte[checked(payload.Length + sizeof(int))];
        BinaryPrimitives.WriteInt32LittleEndian(frame, payload.Length);
        payload.CopyTo(frame.AsSpan(sizeof(int)));
        EnsureWin32(
            WriteFile(
                handle,
                frame,
                checked((uint)frame.Length),
                out uint bytesWritten,
                0),
            "lifecycle-frame-write-failed");
        if (bytesWritten != frame.Length)
        {
            throw new LifecycleProtocolException("short-frame-write");
        }
    }

    private static byte[] ReadLifecycleFrame(nint handle, int timeoutMilliseconds)
    {
        byte[] header = new byte[sizeof(int)];
        ReadLifecyclePipeExact(handle, header, timeoutMilliseconds);
        int payloadLength = BinaryPrimitives.ReadInt32LittleEndian(header);
        if (!IsLifecycleFrameLengthValid(payloadLength))
        {
            throw new LifecycleProtocolException(
                payloadLength > LifecycleMaximumFrameBytes
                    ? "frame-too-large"
                    : "invalid-frame-length");
        }

        byte[] payload = new byte[payloadLength];
        ReadLifecyclePipeExact(handle, payload, timeoutMilliseconds);
        try
        {
            _ = LifecycleUtf8.GetString(payload);
        }
        catch (DecoderFallbackException)
        {
            throw new LifecycleProtocolException("invalid-frame-utf8");
        }

        return payload;
    }

    private static void ReadLifecyclePipeExact(
        nint handle,
        byte[] destination,
        int timeoutMilliseconds)
    {
        int offset = 0;
        var stopwatch = Stopwatch.StartNew();
        while (offset < destination.Length)
        {
            if (!PeekNamedPipe(handle, 0, 0, out _, out uint available, out _))
            {
                int error = Marshal.GetLastWin32Error();
                if (error is LifecycleErrorBrokenPipe or LifecycleErrorNoData)
                {
                    throw new LifecycleChannelClosedException();
                }

                throw new ProofException("lifecycle-pipe-peek-failed", error);
            }

            if (available == 0)
            {
                if (stopwatch.ElapsedMilliseconds >= timeoutMilliseconds)
                {
                    throw new LifecycleProtocolException("frame-read-timeout");
                }

                Thread.Sleep(10);
                continue;
            }

            int remaining = checked(destination.Length - offset);
            int requested = checked((int)Math.Min(available, checked((uint)remaining)));
            byte[] chunk = new byte[requested];
            if (!ReadFile(
                handle,
                chunk,
                checked((uint)chunk.Length),
                out uint bytesRead,
                0))
            {
                int error = Marshal.GetLastWin32Error();
                if (error is LifecycleErrorBrokenPipe or LifecycleErrorNoData)
                {
                    throw new LifecycleChannelClosedException();
                }

                throw new ProofException("lifecycle-frame-read-failed", error);
            }

            if (bytesRead == 0)
            {
                throw new LifecycleChannelClosedException();
            }

            chunk.AsSpan(0, checked((int)bytesRead)).CopyTo(destination.AsSpan(offset));
            offset = checked(offset + (int)bytesRead);
        }
    }

    private static bool TryParseLifecycleRequest(
        byte[] payload,
        out LifecycleRequestFrame? request)
    {
        request = null;
        try
        {
            using JsonDocument document = JsonDocument.Parse(payload);
            JsonElement root = document.RootElement;
            if (!HasExactProperties(
                root,
                [
                    "schemaVersion",
                    "protocolVersion",
                    "command",
                    "scenario",
                    "token",
                    "helperSha256",
                    "helperPayloadSha256",
                    "fixtureSha256",
                ]))
            {
                return false;
            }

            LifecycleRequestFrame? parsed = JsonSerializer.Deserialize<LifecycleRequestFrame>(
                payload,
                LifecycleJsonOptions);
            if (
                parsed is not
                {
                    SchemaVersion: 1,
                    ProtocolVersion: ProtocolVersion,
                    Command: "run-lifecycle-scenario",
                } ||
                !LifecycleTokenPattern().IsMatch(parsed.Token) ||
                !BoundarySha256Pattern().IsMatch(parsed.HelperSha256) ||
                !BoundarySha256Pattern().IsMatch(parsed.HelperPayloadSha256) ||
                !BoundarySha256Pattern().IsMatch(parsed.FixtureSha256) ||
                !IsKnownLifecycleScenario(parsed.Scenario))
            {
                return false;
            }

            request = parsed;
            return true;
        }
        catch (Exception exception) when (
            exception is JsonException or InvalidOperationException or NotSupportedException)
        {
            return false;
        }
    }

    private static bool TryParseLifecycleControl(
        byte[] payload,
        string expectedPhase,
        out LifecycleControlFrame? control)
    {
        control = null;
        try
        {
            using JsonDocument document = JsonDocument.Parse(payload);
            if (!HasExactProperties(
                document.RootElement,
                ["schemaVersion", "protocolVersion", "command", "phase"]))
            {
                return false;
            }

            LifecycleControlFrame? parsed = JsonSerializer.Deserialize<LifecycleControlFrame>(
                payload,
                LifecycleJsonOptions);
            if (parsed is not
                {
                    SchemaVersion: 1,
                    ProtocolVersion: ProtocolVersion,
                    Command: "continue",
                } ||
                !string.Equals(parsed.Phase, expectedPhase, StringComparison.Ordinal))
            {
                return false;
            }

            control = parsed;
            return true;
        }
        catch (Exception exception) when (
            exception is JsonException or InvalidOperationException or NotSupportedException)
        {
            return false;
        }
    }

    private static bool TryParseLifecycleCheckpoint(
        byte[] payload,
        string expectedPhase,
        out LifecycleCheckpointFrame? checkpoint)
    {
        checkpoint = null;
        try
        {
            using JsonDocument document = JsonDocument.Parse(payload);
            if (!HasExactProperties(
                document.RootElement,
                [
                    "schemaVersion",
                    "protocolVersion",
                    "status",
                    "phase",
                    "profileCreated",
                    "stagingCreated",
                    "canaryCreated",
                    "fixtureStaged",
                    "targetCreated",
                    "targetSuspended",
                    "tokenVerified",
                    "jobVerified",
                    "targetReady",
                    "targetExited",
                    "cleanupConfirmed",
                ]))
            {
                return false;
            }

            LifecycleCheckpointFrame? parsed =
                JsonSerializer.Deserialize<LifecycleCheckpointFrame>(
                    payload,
                    LifecycleJsonOptions);
            if (parsed is not
                {
                    SchemaVersion: 1,
                    ProtocolVersion: ProtocolVersion,
                    Status: "checkpoint",
                } ||
                !string.Equals(parsed.Phase, expectedPhase, StringComparison.Ordinal) ||
                !IsKnownLifecyclePhase(parsed.Phase))
            {
                return false;
            }

            checkpoint = parsed;
            return true;
        }
        catch (Exception exception) when (
            exception is JsonException or InvalidOperationException or NotSupportedException)
        {
            return false;
        }
    }

    private static bool TryParseLifecycleReady(byte[] payload)
    {
        try
        {
            using JsonDocument document = JsonDocument.Parse(payload);
            if (!HasExactProperties(
                document.RootElement,
                ["schemaVersion", "status", "code"]))
            {
                return false;
            }

            LifecycleFixtureReadyFrame? parsed =
                JsonSerializer.Deserialize<LifecycleFixtureReadyFrame>(
                    payload,
                    LifecycleJsonOptions);
            return parsed is
            {
                SchemaVersion: 1,
                Status: "ready",
                Code: "lifecycle-ready",
            };
        }
        catch (Exception exception) when (
            exception is JsonException or InvalidOperationException or NotSupportedException)
        {
            return false;
        }
    }

    private static bool TryParseLifecycleFixtureFailure(
        byte[] payload,
        out string? failureCode)
    {
        failureCode = null;
        try
        {
            using JsonDocument document = JsonDocument.Parse(payload);
            if (!HasExactProperties(
                document.RootElement,
                ["schemaVersion", "status", "code"]))
            {
                return false;
            }

            LifecycleFixtureReadyFrame? parsed =
                JsonSerializer.Deserialize<LifecycleFixtureReadyFrame>(
                    payload,
                    LifecycleJsonOptions);
            if (
                parsed is not { SchemaVersion: 1 } ||
                parsed.Status is not ("failed" or "refused") ||
                !LifecycleStableCodePattern().IsMatch(parsed.Code))
            {
                return false;
            }

            failureCode = parsed.Code;
            return true;
        }
        catch (Exception exception) when (
            exception is JsonException or InvalidOperationException or NotSupportedException)
        {
            return false;
        }
    }

    private static string ReadLifecycleFixtureLine(nint handle)
    {
        byte[] output = new byte[MaximumFixtureOutputBytes];
        int offset = 0;
        var stopwatch = Stopwatch.StartNew();
        while (offset < output.Length)
        {
            if (!PeekNamedPipe(handle, 0, 0, out _, out uint available, out _))
            {
                int error = Marshal.GetLastWin32Error();
                if (error is LifecycleErrorBrokenPipe or LifecycleErrorNoData)
                {
                    throw new ProofException("lifecycle-fixture-output-closed", error);
                }

                throw new ProofException("lifecycle-fixture-output-peek-failed", error);
            }

            if (available == 0)
            {
                if (stopwatch.ElapsedMilliseconds >= LifecycleFrameTimeoutMilliseconds)
                {
                    throw new ProofException("lifecycle-fixture-output-timeout");
                }

                Thread.Sleep(10);
                continue;
            }

            int remaining = checked(output.Length - offset);
            int requested = checked((int)Math.Min(available, checked((uint)remaining)));
            byte[] chunk = new byte[requested];
            EnsureWin32(
                ReadFile(
                    handle,
                    chunk,
                    checked((uint)chunk.Length),
                    out uint bytesRead,
                    0),
                "lifecycle-fixture-output-read-failed");
            if (bytesRead == 0)
            {
                throw new ProofException("lifecycle-fixture-output-closed");
            }

            int read = checked((int)bytesRead);
            chunk.AsSpan(0, read).CopyTo(output.AsSpan(offset));
            int newline = chunk.AsSpan(0, read).IndexOf((byte)'\n');
            offset = checked(offset + read);
            if (newline >= 0)
            {
                int lineLength = checked(offset - read + newline);
                for (int index = checked(newline + 1); index < read; index++)
                {
                    if (chunk[index] is not ((byte)'\r' or (byte)'\n'))
                    {
                        throw new ProofException("lifecycle-fixture-output-trailing-data");
                    }
                }

                try
                {
                    return LifecycleUtf8.GetString(output, 0, lineLength).TrimEnd('\r');
                }
                catch (DecoderFallbackException)
                {
                    throw new ProofException("lifecycle-fixture-output-invalid-utf8");
                }
            }
        }

        throw new ProofException("lifecycle-fixture-output-too-large");
    }

    private static bool HasExactProperties(JsonElement root, string[] expected)
    {
        if (root.ValueKind != JsonValueKind.Object)
        {
            return false;
        }

        var remaining = new HashSet<string>(expected, StringComparer.Ordinal);
        int count = 0;
        foreach (JsonProperty property in root.EnumerateObject())
        {
            count++;
            if (!remaining.Remove(property.Name))
            {
                return false;
            }
        }

        return count == expected.Length && remaining.Count == 0;
    }

    private static bool IsLifecycleFrameLengthValid(int length) =>
        length > 0 && length <= LifecycleMaximumFrameBytes;

    private static bool IsKnownLifecycleScenario(string scenario) =>
        LifecycleScenarioSpecs.Any(
            spec => string.Equals(spec.Code, scenario, StringComparison.Ordinal));

    private static bool IsKnownLifecyclePhase(string phase) =>
        phase is
            "request-accepted" or
            "setup-complete" or
            "target-suspended" or
            "target-ready" or
            "target-exited" or
            "cleanup-complete";

    private static nint ParseLifecycleHandle(string text)
    {
        if (
            !long.TryParse(
                text,
                NumberStyles.None,
                CultureInfo.InvariantCulture,
                out long value) ||
            value <= 0 ||
            (nint.Size == sizeof(int) && value > int.MaxValue))
        {
            throw new ProofException("invalid-lifecycle-handle");
        }

        return new nint(value);
    }

    private static int ParseLifecyclePriorCount(string text, int maximum)
    {
        if (
            !int.TryParse(
                text,
                NumberStyles.None,
                CultureInfo.InvariantCulture,
                out int value) ||
            value < 0 ||
            value > maximum)
        {
            throw new ProofException("invalid-lifecycle-prior-count");
        }

        return value;
    }

    private static string ValidateLifecycleExecutable(
        string path,
        string expectedSha256,
        string expectedFileName,
        string errorCode)
    {
        if (
            !Path.IsPathFullyQualified(path) ||
            !BoundarySha256Pattern().IsMatch(expectedSha256))
        {
            throw new ProofException(errorCode);
        }

        string canonical = Path.GetFullPath(path);
        if (
            !File.Exists(canonical) ||
            !string.Equals(
                Path.GetFileName(canonical),
                expectedFileName,
                StringComparison.Ordinal) ||
            HasReparsePoint(canonical) ||
            !string.Equals(HashFile(canonical), expectedSha256, StringComparison.Ordinal))
        {
            throw new ProofException(errorCode);
        }

        return canonical;
    }

    private static bool HasReparsePoint(string path)
    {
        string canonical = Path.GetFullPath(path);
        string? current = canonical;
        while (current is not null)
        {
            if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
            {
                return true;
            }

            string? parent = Path.GetDirectoryName(current);
            if (string.IsNullOrEmpty(parent) || string.Equals(parent, current, StringComparison.Ordinal))
            {
                break;
            }

            current = parent;
        }

        return false;
    }

    private sealed class LifecycleResources
    {
        private LifecycleResources(
            string token,
            string profileName,
            string profileSid,
            string stagingRoot,
            string canaryRoot)
        {
            Token = token;
            ProfileName = profileName;
            ProfileSid = profileSid;
            StagingRoot = stagingRoot;
            CanaryRoot = canaryRoot;
            StagedFixture = Path.Combine(
                stagingRoot,
                $"stage17-helper-fixture-{token}.exe");
            AllowedFile = Path.Combine(stagingRoot, "allowed.txt");
            CanaryFile = Path.Combine(canaryRoot, "canary.txt");
            MarkerRoot = Path.Combine(stagingRoot, "marker");
            MarkerFile = Path.Combine(
                MarkerRoot,
                $"stage17-helper-lifecycle-{token}.marker");
            ProfileFolder = string.Empty;
        }

        internal string Token { get; }

        internal string ProfileName { get; }

        internal string ProfileSid { get; }

        internal string ProfileFolder { get; private set; }

        internal string StagingRoot { get; }

        internal string CanaryRoot { get; }

        internal string StagedFixture { get; }

        internal string AllowedFile { get; }

        internal string CanaryFile { get; }

        internal string MarkerRoot { get; }

        internal string MarkerFile { get; }

        internal bool ProfileFolderResolved => ProfileFolder.Length > 0;

        internal static LifecycleResources Create(string token)
        {
            if (!LifecycleTokenPattern().IsMatch(token))
            {
                throw new ProofException("invalid-lifecycle-token");
            }

            string tempRoot = Path.TrimEndingDirectorySeparator(
                Path.GetFullPath(Path.GetTempPath()));
            string profileName = $"{LifecycleProfilePrefix}{token}";
            string profileSid = DeriveSidString(profileName);
            string stagingRoot = ValidateLifecycleDirectTempChild(
                Path.Combine(tempRoot, $"{LifecycleStagingPrefix}{token}"),
                $"{LifecycleStagingPrefix}{token}");
            string canaryRoot = ValidateLifecycleDirectTempChild(
                Path.Combine(tempRoot, $"{LifecycleCanaryPrefix}{token}"),
                $"{LifecycleCanaryPrefix}{token}");
            return new LifecycleResources(
                token,
                profileName,
                profileSid,
                stagingRoot,
                canaryRoot);
        }

        internal void ResolveProfileFolder()
        {
            if (ProfileFolderResolved)
            {
                return;
            }

            ProfileFolder = GetProfileFolder(ProfileSid);
        }

        internal bool TryResolveProfileFolder()
        {
            try
            {
                ResolveProfileFolder();
                return true;
            }
            catch (Exception exception) when (!IsFatal(exception))
            {
                return false;
            }
        }
    }

    private static string ValidateLifecycleDirectTempChild(
        string path,
        string expectedName)
    {
        string canonical = Path.GetFullPath(path);
        string tempRoot = Path.TrimEndingDirectorySeparator(
            Path.GetFullPath(Path.GetTempPath()));
        if (
            !string.Equals(
                Path.GetDirectoryName(canonical),
                tempRoot,
                StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(Path.GetFileName(canonical), expectedName, StringComparison.Ordinal))
        {
            throw new ProofException("invalid-lifecycle-temp-child");
        }

        return canonical;
    }

    private sealed record LifecycleScenarioSpec(
        string Code,
        string Interruption,
        string ExpectedPhase);

    private sealed record LifecycleRequestFrame(
        int SchemaVersion,
        int ProtocolVersion,
        string Command,
        string Scenario,
        string Token,
        string HelperSha256,
        string HelperPayloadSha256,
        string FixtureSha256);

    private sealed record LifecycleControlFrame(
        int SchemaVersion,
        int ProtocolVersion,
        string Command,
        string Phase);

    private sealed record LifecycleCheckpointFrame(
        int SchemaVersion,
        int ProtocolVersion,
        string Status,
        string Phase,
        bool ProfileCreated,
        bool StagingCreated,
        bool CanaryCreated,
        bool FixtureStaged,
        bool TargetCreated,
        bool TargetSuspended,
        bool TokenVerified,
        bool JobVerified,
        bool TargetReady,
        bool TargetExited,
        bool CleanupConfirmed);

    private sealed record LifecycleRefusalFrame(
        int SchemaVersion,
        int ProtocolVersion,
        string Status,
        string Code);

    private sealed record LifecycleFixtureReadyFrame(
        int SchemaVersion,
        string Status,
        string Code);

    private sealed class LifecycleProtocolException : Exception
    {
        internal LifecycleProtocolException(string code)
            : base(code)
        {
            Code = code;
        }

        internal string Code { get; }
    }

    private sealed class LifecycleChannelClosedException : Exception;

    [GeneratedRegex("^[a-f0-9]{32}$", RegexOptions.CultureInvariant)]
    private static partial Regex LifecycleTokenPattern();

    [GeneratedRegex("^[a-z0-9-]{1,96}$", RegexOptions.CultureInvariant)]
    private static partial Regex LifecycleStableCodePattern();

    [GeneratedRegex(
        "^ai-dev-os-stage17-helper-proof-[a-f0-9]{32}$",
        RegexOptions.CultureInvariant)]
    private static partial Regex LifecycleStagingDirectoryNamePattern();

    [GeneratedRegex(
        "^ai-dev-os-stage17-helper-canary-[a-f0-9]{32}$",
        RegexOptions.CultureInvariant)]
    private static partial Regex LifecycleCanaryDirectoryNamePattern();

    [DllImport(
        "kernel32.dll",
        EntryPoint = "WriteFile",
        ExactSpelling = true,
        SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WriteFile(
        nint fileHandle,
        byte[] buffer,
        uint bytesToWrite,
        out uint bytesWritten,
        nint overlapped);

    [DllImport(
        "kernel32.dll",
        EntryPoint = "PeekNamedPipe",
        ExactSpelling = true,
        SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool PeekNamedPipe(
        nint namedPipeHandle,
        nint buffer,
        uint bufferSize,
        out uint bytesRead,
        out uint totalBytesAvailable,
        out uint bytesLeftThisMessage);

    [DllImport(
        "kernel32.dll",
        EntryPoint = "TerminateProcess",
        ExactSpelling = true,
        SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateProcess(nint processHandle, uint exitCode);
}

internal sealed record HelperLifecycleCrashProofResult(
    int SchemaVersion,
    int ProtocolVersion,
    string Status,
    string Reason,
    string HelperSha256,
    string HelperPayloadSha256,
    string FixtureSha256,
    int MaximumFrameBytes,
    bool OneRequestPerHelper,
    bool InheritedAmbientEnvironment,
    int ExplicitHelperHandleCount,
    int ProfileCreationLimit,
    int FixtureProcessCreationLimit,
    int TotalTaskProcessCreationLimit,
    int PriorProfileCreateCount,
    int PriorHelperProcessCreateCount,
    int PriorFixtureProcessCreateCount,
    int PriorOtherTaskProcessCreateCount,
    int ProfileCreateCount,
    int HelperProcessCreateCount,
    int FixtureProcessCreateCount,
    int TotalTaskProcessCreateCount,
    int ScenarioCount,
    IReadOnlyList<HelperLifecycleScenarioResult> Scenarios,
    LifecycleResidueScan FinalResidueScan,
    bool CapsRespected,
    bool StoppedAfterFailure,
    bool ManualRecoveryRequired,
    bool ProductionBackendAvailable);

internal sealed record HelperLifecycleScenarioResult(
    int SchemaVersion,
    string Scenario,
    string Status,
    string Reason,
    int? NativeErrorCode,
    string ProfileNameFingerprint,
    string ProfileSidFingerprint,
    string StagingRootFingerprint,
    string CanaryRootFingerprint,
    string ExpectedPhase,
    bool ExpectedPhaseObserved,
    bool ClientDisconnected,
    bool HelperTerminationInjected,
    bool HelperTerminationHandleBased,
    bool HelperProcessCreated,
    bool HelperExitObserved,
    uint? HelperExitCode,
    bool ProfileCreated,
    bool FixtureProcessCreated,
    bool TargetSuspended,
    bool TargetReady,
    bool TargetExited,
    bool MarkerAbsentBeforeResume,
    bool MarkerObservedBeforeRecovery,
    bool JobTerminationAttempted,
    bool JobTerminationSucceeded,
    bool JobDrained,
    uint? JobTotalProcesses,
    uint? JobActiveProcesses,
    bool NoDescendantProcessSurvived,
    bool HelperOwnedCleanup,
    bool SupervisorRecoveryPerformed,
    bool SupervisorRecoveryConfirmed,
    bool ControllerHandlesClosed,
    LifecycleResidueScan IndependentResidueScan,
    bool ManualRecoveryRequired,
    LifecycleResidueScan PostRecoveryResidueScan);

internal sealed record LifecycleResidueScan(
    int FilesystemResidueCount,
    int MarkerResidueCount,
    int PackageFolderResidueCount,
    int RegistryResidueCount,
    int HelperProcessResidueCount,
    int FixtureProcessResidueCount,
    int GenericTaskDirectoryResidueCount,
    int GenericRegistryResidueCount)
{
    internal static LifecycleResidueScan NotRun { get; } =
        new(-1, -1, -1, -1, -1, -1, -1, -1);

    public bool IsZero =>
        FilesystemResidueCount == 0 &&
        MarkerResidueCount == 0 &&
        PackageFolderResidueCount == 0 &&
        RegistryResidueCount == 0 &&
        HelperProcessResidueCount == 0 &&
        FixtureProcessResidueCount == 0 &&
        GenericTaskDirectoryResidueCount == 0 &&
        GenericRegistryResidueCount == 0;
}

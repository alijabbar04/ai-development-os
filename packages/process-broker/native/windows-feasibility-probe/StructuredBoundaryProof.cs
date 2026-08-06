using System;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;

namespace AiDevOs.WindowsSandboxFeasibilityProbe;

internal static partial class AppContainerSyntheticProcessProof
{
    private const string BoundaryProfilePrefix = "AiDevOs.Stage17.BoundaryProof.";
    private const string BoundaryStagingRootPrefix = "ai-dev-os-stage17-boundary-proof-";
    private const string BoundaryCanaryRootPrefix = "ai-dev-os-stage17-boundary-canary-";
    private const string BoundaryFixtureFileName = "AI.DevOS.WindowsBoundaryFixture.exe";
    private const string BoundaryAllowedContent = "stage17-boundary-allowed-v1";
    private const string BoundaryCanaryContent = "stage17-boundary-canary-v1";
    private const int BoundaryChildAttempts = 8;
    private const uint BoundaryProcessWaitMilliseconds = 60_000;

    public static StructuredBoundaryProofResult RunStructuredBoundary(
        string profileName,
        string stagingRoot,
        string canaryRoot,
        string fixtureSource,
        string expectedFixtureSha256)
    {
        string token = ValidateBoundaryProfileName(profileName);
        string canonicalStagingRoot = ValidateBoundaryRoot(
            stagingRoot,
            BoundaryStagingRootPrefix,
            token,
            nameof(stagingRoot));
        string canonicalCanaryRoot = ValidateBoundaryRoot(
            canaryRoot,
            BoundaryCanaryRootPrefix,
            token,
            nameof(canaryRoot));
        string canonicalFixtureSource = ValidateBoundaryFixture(
            fixtureSource,
            expectedFixtureSha256);
        string sourceFixtureSha256 = HashFile(canonicalFixtureSource);

        bool profileCreated = false;
        bool profileFolderObserved = false;
        bool mappingRegistryObserved = false;
        bool storageRegistryObserved = false;
        bool sidFreed = true;
        bool stagingDirectoryCreated = false;
        bool stagingAclGrantObserved = false;
        bool fixtureAclGrantObserved = false;
        bool allowedFileAclGrantObserved = false;
        bool canaryDirectoryCreated = false;
        bool canaryAclProtected = false;
        bool canarySidRuleAbsent = false;
        bool stagedFixtureCopied = false;
        bool stagedFixtureBytesMatched = false;
        bool sourceFixtureIsReparsePoint = false;
        bool jobCreated = false;
        bool killOnJobCloseConfigured = false;
        bool activeProcessLimitConfigured = false;
        bool creationAttributesConfigured = false;
        bool loopbackListenerCreated = false;
        bool loopbackPositiveControlPassed = false;
        bool loopbackAppContainerConnectionAbsent = false;
        bool loopbackAppContainerDatagramAbsent = false;
        bool processCreationAttempted = false;
        bool processCreated = false;
        bool appContainerTokenObserved = false;
        bool profileSidMatched = false;
        int? tokenCapabilityCount = null;
        bool processInPrivateJobBeforeResume = false;
        uint? privateJobActiveProcessCountBeforeResume = null;
        bool resumeAttempted = false;
        uint? resumePreviousSuspendCount = null;
        bool processExitObserved = false;
        bool processExitCodeZero = false;
        bool fixtureJsonParsed = false;
        BoundaryFixtureOutput? fixtureOutput = null;
        uint? privateJobTotalProcessCountAfterExit = null;
        uint? privateJobActiveProcessCountAfterExit = null;
        bool canaryContentUnchanged = false;
        bool forbiddenStagingWriteAbsent = false;
        bool jobTerminationAttempted = false;
        bool jobTerminationSucceeded = false;
        bool jobDrained = false;
        bool stagingAclRestored = false;
        bool stagedFixtureRemoved = false;
        bool allowedFileRemoved = false;
        bool forbiddenStagingWriteRemoved = false;
        bool stagingDirectoryRemoved = false;
        bool canaryFileRemoved = false;
        bool canaryDirectoryRemoved = false;
        int deleteAttempts = 0;
        bool profileDeleteSucceeded = false;
        int? nativeErrorCode = null;
        string reason = "structured-boundary-proof-failed";
        string? profileSid = null;
        string? profileFolder = null;
        string? originalStagingAcl = null;
        string? stagedFixtureSha256 = null;

        nint profileSidPointer = 0;
        nint jobHandle = 0;
        nint standardInputHandle = 0;
        nint standardOutputReadHandle = 0;
        nint standardOutputWriteHandle = 0;
        nint processHandle = 0;
        nint threadHandle = 0;
        nint processTokenHandle = 0;
        nint attributeList = 0;
        bool attributeListInitialized = false;
        nint securityCapabilitiesPointer = 0;
        nint jobListPointer = 0;
        nint handleListPointer = 0;
        nint environmentPointer = 0;
        TcpListener? listener = null;
        Socket? udpReceiver = null;

        string stagedFixture = Path.Combine(
            canonicalStagingRoot,
            $"stage17-boundary-fixture-{token}.exe");
        string allowedFile = Path.Combine(canonicalStagingRoot, "allowed.txt");
        string forbiddenStagingWrite = Path.Combine(canonicalStagingRoot, "forbidden.txt");
        string canaryFile = Path.Combine(canonicalCanaryRoot, "canary.txt");

        try
        {
            profileSid = DeriveSidString(profileName);
            if (
                Directory.Exists(canonicalStagingRoot) ||
                Directory.Exists(canonicalCanaryRoot) ||
                RegistryKeyExists(MappingRegistryPath(profileSid)) ||
                RegistryKeyExists(StorageRegistryPath(profileName)))
            {
                reason = "preexisting-boundary-proof-state";
            }
            else
            {
                DirectoryInfo stagingDirectory = Directory.CreateDirectory(canonicalStagingRoot);
                stagingDirectoryCreated = true;
                DirectorySecurity initialStagingSecurity = stagingDirectory.GetAccessControl(
                    AccessControlSections.Access);
                originalStagingAcl = initialStagingSecurity.GetSecurityDescriptorSddlForm(
                    AccessControlSections.Access);

                int createResult = CreateAppContainerProfile(
                    profileName,
                    "AI Development OS Stage 17 boundary proof",
                    "Bounded structured filesystem network and child-process proof",
                    0,
                    0,
                    out profileSidPointer);
                if (createResult != 0 || profileSidPointer == 0)
                {
                    throw new ProofException("profile-create-failed", createResult);
                }

                profileCreated = true;
                string returnedSid = new SecurityIdentifier(profileSidPointer).Value;
                if (!string.Equals(returnedSid, profileSid, StringComparison.Ordinal))
                {
                    throw new ProofException("profile-sid-mismatch");
                }

                profileFolder = GetProfileFolder(profileSid);
                profileFolderObserved = Directory.Exists(profileFolder);
                mappingRegistryObserved = RegistryKeyExists(MappingRegistryPath(profileSid));
                storageRegistryObserved = RegistryKeyExists(StorageRegistryPath(profileName));

                var appContainerSid = new SecurityIdentifier(profileSid);
                GrantStagingAccess(stagingDirectory, appContainerSid);
                stagingAclGrantObserved = HasAllowRule(
                    stagingDirectory.GetAccessControl(AccessControlSections.Access),
                    appContainerSid,
                    requireExplicit: true);

                sourceFixtureIsReparsePoint =
                    (File.GetAttributes(canonicalFixtureSource) & FileAttributes.ReparsePoint) != 0;
                if (sourceFixtureIsReparsePoint)
                {
                    throw new ProofException("source-fixture-is-reparse-point");
                }

                File.Copy(canonicalFixtureSource, stagedFixture, overwrite: false);
                stagedFixtureCopied = true;
                stagedFixtureSha256 = HashFile(stagedFixture);
                stagedFixtureBytesMatched = string.Equals(
                    sourceFixtureSha256,
                    stagedFixtureSha256,
                    StringComparison.Ordinal);
                File.WriteAllText(allowedFile, BoundaryAllowedContent, Encoding.UTF8);
                if (!stagedFixtureBytesMatched)
                {
                    throw new ProofException("staged-fixture-digest-mismatch");
                }

                fixtureAclGrantObserved = HasAllowRule(
                    new FileInfo(stagedFixture).GetAccessControl(AccessControlSections.Access),
                    appContainerSid,
                    requireExplicit: false);
                allowedFileAclGrantObserved = HasAllowRule(
                    new FileInfo(allowedFile).GetAccessControl(AccessControlSections.Access),
                    appContainerSid,
                    requireExplicit: false);
                if (
                    !stagingAclGrantObserved ||
                    !fixtureAclGrantObserved ||
                    !allowedFileAclGrantObserved)
                {
                    throw new ProofException("staging-acl-observation-incomplete");
                }

                DirectoryInfo canaryDirectory = Directory.CreateDirectory(canonicalCanaryRoot);
                canaryDirectoryCreated = true;
                ConfigureCanaryAcl(canaryDirectory);
                File.WriteAllText(canaryFile, BoundaryCanaryContent, Encoding.UTF8);
                DirectorySecurity canarySecurity = canaryDirectory.GetAccessControl(
                    AccessControlSections.Access);
                canaryAclProtected = canarySecurity.AreAccessRulesProtected;
                canarySidRuleAbsent = !HasAnyRule(canarySecurity, appContainerSid);
                if (!canaryAclProtected || !canarySidRuleAbsent)
                {
                    throw new ProofException("canary-acl-observation-incomplete");
                }

                listener = new TcpListener(IPAddress.Loopback, 0);
                listener.Server.ExclusiveAddressUse = true;
                listener.Start(1);
                loopbackListenerCreated = true;
                int loopbackPort = ((IPEndPoint)listener.LocalEndpoint).Port;
                using (var positiveClient = new TcpClient(AddressFamily.InterNetwork))
                {
                    positiveClient.Connect(IPAddress.Loopback, loopbackPort);
                    using TcpClient acceptedClient = listener.AcceptTcpClient();
                    loopbackPositiveControlPassed = positiveClient.Connected && acceptedClient.Connected;
                }

                udpReceiver = new Socket(
                    AddressFamily.InterNetwork,
                    SocketType.Dgram,
                    ProtocolType.Udp);
                udpReceiver.ExclusiveAddressUse = true;
                udpReceiver.Bind(new IPEndPoint(IPAddress.Loopback, loopbackPort));
                using (var positiveUdp = new Socket(
                    AddressFamily.InterNetwork,
                    SocketType.Dgram,
                    ProtocolType.Udp))
                {
                    byte[] positivePayload = [0x53, 0x31, 0x37];
                    int sent = positiveUdp.SendTo(
                        positivePayload,
                        new IPEndPoint(IPAddress.Loopback, loopbackPort));
                    bool readable = udpReceiver.Poll(1_000_000, SelectMode.SelectRead);
                    byte[] receivedPayload = new byte[positivePayload.Length];
                    EndPoint remote = new IPEndPoint(IPAddress.Any, 0);
                    int received = readable
                        ? udpReceiver.ReceiveFrom(receivedPayload, ref remote)
                        : 0;
                    loopbackPositiveControlPassed =
                        loopbackPositiveControlPassed &&
                        sent == positivePayload.Length &&
                        received == positivePayload.Length &&
                        receivedPayload.AsSpan().SequenceEqual(positivePayload);
                }

                if (!loopbackPositiveControlPassed)
                {
                    throw new ProofException("loopback-positive-control-failed");
                }

                jobHandle = CreateJobObjectW(0, null);
                EnsureHandle(jobHandle, "job-create-failed");
                jobCreated = true;
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
                    "job-limits-configure-failed");
                killOnJobCloseConfigured = true;
                activeProcessLimitConfigured = true;

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
                creationAttributesConfigured = true;

                environmentPointer = CreateBoundaryEnvironment(
                    stagedFixture,
                    profileFolder,
                    canonicalStagingRoot);
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
                char[] commandLine = BuildBoundaryCommandLine(
                    stagedFixture,
                    allowedFile,
                    canaryFile,
                    forbiddenStagingWrite,
                    loopbackPort);

                processCreationAttempted = true;
                bool created = CreateProcessW(
                    stagedFixture,
                    commandLine,
                    0,
                    0,
                    inheritHandles: true,
                    CreateSuspended | CreateUnicodeEnvironment | ExtendedStartupInfoPresent,
                    environmentPointer,
                    canonicalStagingRoot,
                    ref startupInfo,
                    out ProcessInformation processInformation);
                if (!created)
                {
                    throw new ProofException(
                        "structured-boundary-process-create-failed",
                        Marshal.GetLastWin32Error());
                }

                processCreated = true;
                processHandle = processInformation.Process;
                threadHandle = processInformation.Thread;
                CloseNativeHandle(ref standardOutputWriteHandle);

                EnsureWin32(
                    OpenProcessToken(processHandle, TokenQuery, out processTokenHandle),
                    "process-token-open-failed");
                appContainerTokenObserved = ReadTokenUInt32(
                    processTokenHandle,
                    TokenIsAppContainer,
                    "token-appcontainer-query-failed") != 0;
                profileSidMatched = string.Equals(
                    ReadTokenAppContainerSid(processTokenHandle),
                    profileSid,
                    StringComparison.Ordinal);
                tokenCapabilityCount = checked((int)ReadTokenGroupCount(
                    processTokenHandle,
                    TokenCapabilities,
                    "token-capabilities-query-failed"));
                EnsureWin32(
                    IsProcessInJob(processHandle, jobHandle, out processInPrivateJobBeforeResume),
                    "process-job-membership-query-failed");
                JobObjectBasicAccountingInformation accountingBefore = QueryJobAccounting(jobHandle);
                privateJobActiveProcessCountBeforeResume = accountingBefore.ActiveProcesses;
                if (
                    !appContainerTokenObserved ||
                    !profileSidMatched ||
                    tokenCapabilityCount != 0 ||
                    !processInPrivateJobBeforeResume ||
                    privateJobActiveProcessCountBeforeResume != 1)
                {
                    throw new ProofException("pre-resume-boundary-observation-failed");
                }

                resumeAttempted = true;
                uint previousSuspendCount = ResumeThread(threadHandle);
                if (previousSuspendCount == uint.MaxValue)
                {
                    throw new ProofException("thread-resume-failed", Marshal.GetLastWin32Error());
                }

                resumePreviousSuspendCount = previousSuspendCount;
                uint waitResult = WaitForSingleObject(
                    processHandle,
                    BoundaryProcessWaitMilliseconds);
                if (waitResult == WaitTimeout)
                {
                    throw new ProofException("structured-boundary-process-timeout");
                }

                if (waitResult != WaitObject0)
                {
                    throw new ProofException(
                        "structured-boundary-process-wait-failed",
                        Marshal.GetLastWin32Error());
                }

                processExitObserved = true;
                EnsureWin32(
                    GetExitCodeProcess(processHandle, out uint exitCode),
                    "structured-boundary-exit-code-query-failed");
                processExitCodeZero = exitCode == 0;
                fixtureOutput = JsonSerializer.Deserialize<BoundaryFixtureOutput>(
                    ReadBoundaryFixtureOutput(standardOutputReadHandle),
                    BoundaryFixtureJsonOptions);
                fixtureJsonParsed = fixtureOutput is not null;
                JobObjectBasicAccountingInformation accountingAfter = QueryJobAccounting(jobHandle);
                privateJobTotalProcessCountAfterExit = accountingAfter.TotalProcesses;
                privateJobActiveProcessCountAfterExit = accountingAfter.ActiveProcesses;
                loopbackAppContainerConnectionAbsent = !listener.Pending();
                loopbackAppContainerDatagramAbsent =
                    !udpReceiver.Poll(250_000, SelectMode.SelectRead) &&
                    udpReceiver.Available == 0;
                canaryContentUnchanged =
                    string.Equals(
                        File.ReadAllText(canaryFile, Encoding.UTF8),
                        BoundaryCanaryContent,
                        StringComparison.Ordinal);
                forbiddenStagingWriteAbsent = !File.Exists(forbiddenStagingWrite);

                if (
                    resumePreviousSuspendCount != 1 ||
                    !processExitCodeZero ||
                    !FixtureOutputPassed(fixtureOutput) ||
                    privateJobTotalProcessCountAfterExit != 1 ||
                    privateJobActiveProcessCountAfterExit != 0 ||
                    !loopbackAppContainerConnectionAbsent ||
                    !loopbackAppContainerDatagramAbsent ||
                    !canaryContentUnchanged ||
                    !forbiddenStagingWriteAbsent)
                {
                    throw new ProofException("structured-boundary-observation-failed");
                }

                reason = "structured-boundary-observations-complete";
            }
        }
        catch (ProofException exception)
        {
            reason = exception.Code;
            nativeErrorCode = exception.NativeErrorCode;
        }
        catch (JsonException)
        {
            reason = "structured-boundary-fixture-json-invalid";
        }
        catch (Exception exception) when (!IsFatal(exception))
        {
            reason = "structured-boundary-proof-exception";
        }
        finally
        {
            udpReceiver?.Dispose();
            listener?.Stop();
            if (attributeListInitialized)
            {
                DeleteProcThreadAttributeList(attributeList);
            }

            FreeUnmanaged(ref attributeList);
            FreeUnmanaged(ref securityCapabilitiesPointer);
            FreeUnmanaged(ref jobListPointer);
            FreeUnmanaged(ref handleListPointer);
            FreeUnmanaged(ref environmentPointer);
            CloseNativeHandle(ref standardOutputWriteHandle);
            CloseNativeHandle(ref standardInputHandle);

            if (jobHandle != 0)
            {
                jobTerminationAttempted = true;
                jobTerminationSucceeded = TerminateJobObject(jobHandle, 1);
                jobDrained = WaitForSingleObject(jobHandle, JobDrainWaitMilliseconds) == WaitObject0;
            }

            if (processHandle != 0 && !processExitObserved)
            {
                processExitObserved =
                    WaitForSingleObject(processHandle, JobDrainWaitMilliseconds) == WaitObject0;
            }

            CloseNativeHandle(ref processTokenHandle);
            CloseNativeHandle(ref threadHandle);
            CloseNativeHandle(ref processHandle);
            CloseNativeHandle(ref standardOutputReadHandle);
            CloseNativeHandle(ref jobHandle);

            if (profileSidPointer != 0)
            {
                sidFreed = FreeSid(profileSidPointer) == 0;
                profileSidPointer = 0;
            }

            if (Directory.Exists(canonicalStagingRoot))
            {
                try
                {
                    DeleteExactFile(stagedFixture, ref stagedFixtureRemoved);
                    DeleteExactFile(allowedFile, ref allowedFileRemoved);
                    DeleteExactFile(forbiddenStagingWrite, ref forbiddenStagingWriteRemoved);
                    var stagingDirectory = new DirectoryInfo(canonicalStagingRoot);
                    if (originalStagingAcl is not null && profileSid is not null)
                    {
                        stagingAclRestored = RestoreAcl(
                            stagingDirectory,
                            originalStagingAcl,
                            new SecurityIdentifier(profileSid));
                    }

                    if (stagingAclRestored && !stagingDirectory.EnumerateFileSystemInfos().Any())
                    {
                        Directory.Delete(canonicalStagingRoot, recursive: false);
                    }
                }
                catch (Exception exception) when (!IsFatal(exception))
                {
                    stagingAclRestored = false;
                }
            }

            stagedFixtureRemoved = !File.Exists(stagedFixture);
            allowedFileRemoved = !File.Exists(allowedFile);
            forbiddenStagingWriteRemoved = !File.Exists(forbiddenStagingWrite);
            stagingDirectoryRemoved = !Directory.Exists(canonicalStagingRoot);

            if (Directory.Exists(canonicalCanaryRoot))
            {
                try
                {
                    if (File.Exists(canaryFile))
                    {
                        File.Delete(canaryFile);
                    }

                    canaryFileRemoved = !File.Exists(canaryFile);
                    var canaryDirectory = new DirectoryInfo(canonicalCanaryRoot);
                    if (!canaryDirectory.EnumerateFileSystemInfos().Any())
                    {
                        Directory.Delete(canonicalCanaryRoot, recursive: false);
                    }
                }
                catch (Exception exception) when (!IsFatal(exception))
                {
                    canaryFileRemoved = false;
                }
            }

            canaryFileRemoved = !File.Exists(canaryFile);
            canaryDirectoryRemoved = !Directory.Exists(canonicalCanaryRoot);

            if (profileCreated)
            {
                deleteAttempts++;
                profileDeleteSucceeded = DeleteAppContainerProfile(profileName) == 0;
                if (!profileDeleteSucceeded)
                {
                    Thread.Sleep(CleanupObservationDelayMs);
                    deleteAttempts++;
                    profileDeleteSucceeded = DeleteAppContainerProfile(profileName) == 0;
                }
            }
        }

        bool profileFolderResidueAbsent = profileFolder is null || !Directory.Exists(profileFolder);
        bool mappingRegistryResidueAbsent =
            profileSid is null || !RegistryKeyExists(MappingRegistryPath(profileSid));
        bool storageRegistryResidueAbsent = !RegistryKeyExists(StorageRegistryPath(profileName));
        if (
            profileCreated &&
            profileDeleteSucceeded &&
            (!profileFolderResidueAbsent ||
             !mappingRegistryResidueAbsent ||
             !storageRegistryResidueAbsent))
        {
            for (int attempt = 0; attempt < CleanupObservationAttempts; attempt++)
            {
                Thread.Sleep(CleanupObservationDelayMs);
                profileFolderResidueAbsent = profileFolder is null || !Directory.Exists(profileFolder);
                mappingRegistryResidueAbsent =
                    profileSid is null || !RegistryKeyExists(MappingRegistryPath(profileSid));
                storageRegistryResidueAbsent =
                    !RegistryKeyExists(StorageRegistryPath(profileName));
                if (
                    profileFolderResidueAbsent &&
                    mappingRegistryResidueAbsent &&
                    storageRegistryResidueAbsent)
                {
                    break;
                }
            }
        }

        bool preResumeBoundaryObserved =
            appContainerTokenObserved &&
            profileSidMatched &&
            tokenCapabilityCount == 0 &&
            processInPrivateJobBeforeResume &&
            privateJobActiveProcessCountBeforeResume == 1 &&
            resumePreviousSuspendCount == 1;
        bool fixtureAssertionsPassed = FixtureOutputPassed(fixtureOutput);
        bool processCleanupConfirmed =
            processExitObserved &&
            jobTerminationAttempted &&
            jobTerminationSucceeded &&
            jobDrained;
        bool cleanupConfirmed =
            processCleanupConfirmed &&
            sidFreed &&
            stagingAclRestored &&
            stagedFixtureRemoved &&
            allowedFileRemoved &&
            forbiddenStagingWriteRemoved &&
            stagingDirectoryRemoved &&
            canaryFileRemoved &&
            canaryDirectoryRemoved &&
            profileCreated &&
            profileDeleteSucceeded &&
            profileFolderResidueAbsent &&
            mappingRegistryResidueAbsent &&
            storageRegistryResidueAbsent;
        bool passed =
            cleanupConfirmed &&
            profileFolderObserved &&
            mappingRegistryObserved &&
            storageRegistryObserved &&
            stagingDirectoryCreated &&
            stagingAclGrantObserved &&
            fixtureAclGrantObserved &&
            allowedFileAclGrantObserved &&
            canaryDirectoryCreated &&
            canaryAclProtected &&
            canarySidRuleAbsent &&
            stagedFixtureCopied &&
            stagedFixtureBytesMatched &&
            !sourceFixtureIsReparsePoint &&
            jobCreated &&
            killOnJobCloseConfigured &&
            activeProcessLimitConfigured &&
            creationAttributesConfigured &&
            loopbackListenerCreated &&
            loopbackPositiveControlPassed &&
            loopbackAppContainerConnectionAbsent &&
            loopbackAppContainerDatagramAbsent &&
            processCreationAttempted &&
            processCreated &&
            preResumeBoundaryObserved &&
            processExitCodeZero &&
            fixtureJsonParsed &&
            fixtureAssertionsPassed &&
            privateJobTotalProcessCountAfterExit == 1 &&
            privateJobActiveProcessCountAfterExit == 0 &&
            canaryContentUnchanged &&
            forbiddenStagingWriteAbsent;

        if (passed)
        {
            reason = "structured-boundary-proof-passed";
        }
        else if (!cleanupConfirmed && (profileCreated || processCreated))
        {
            reason = "structured-boundary-cleanup-unconfirmed";
        }

        return new StructuredBoundaryProofResult(
            SchemaVersion: 1,
            ProtocolVersion: ProtocolVersion,
            Status: passed ? "passed" : "failed",
            Reason: reason,
            NativeErrorCode: nativeErrorCode,
            ProfileNameFingerprint: Fingerprint(profileName),
            ProfileSidFingerprint: profileSid is null ? null : Fingerprint(profileSid),
            StagingRootFingerprint: Fingerprint(canonicalStagingRoot),
            CanaryRootFingerprint: Fingerprint(canonicalCanaryRoot),
            SourceFixtureSha256: sourceFixtureSha256,
            StagedFixtureSha256: stagedFixtureSha256,
            ProfileCreated: profileCreated,
            CapabilitiesRequested: false,
            ProfileFolderObserved: profileFolderObserved,
            MappingRegistryObserved: mappingRegistryObserved,
            StorageRegistryObserved: storageRegistryObserved,
            StagingDirectoryCreated: stagingDirectoryCreated,
            StagingAclGrantObserved: stagingAclGrantObserved,
            FixtureAclGrantObserved: fixtureAclGrantObserved,
            AllowedFileAclGrantObserved: allowedFileAclGrantObserved,
            CanaryDirectoryCreated: canaryDirectoryCreated,
            CanaryAclProtected: canaryAclProtected,
            CanarySidRuleAbsent: canarySidRuleAbsent,
            SourceFixtureIsReparsePoint: sourceFixtureIsReparsePoint,
            StagedFixtureCopied: stagedFixtureCopied,
            StagedFixtureBytesMatched: stagedFixtureBytesMatched,
            JobCreated: jobCreated,
            KillOnJobCloseConfigured: killOnJobCloseConfigured,
            ActiveProcessLimitConfigured: activeProcessLimitConfigured,
            BreakawayAllowed: false,
            CreationAttributeCount: creationAttributesConfigured ? 3 : 0,
            InheritedHandleCount: creationAttributesConfigured ? 2 : 0,
            MinimalEnvironmentEntryCount: creationAttributesConfigured ? 9 : 0,
            LoopbackOnly: true,
            PublicNetworkAttempted: false,
            LoopbackPositiveControlPassed: loopbackPositiveControlPassed,
            ProcessCreationAttempted: processCreationAttempted,
            ProcessCreated: processCreated,
            CreatedSuspended: processCreated,
            AppContainerTokenObserved: appContainerTokenObserved,
            ProfileSidMatched: profileSidMatched,
            TokenCapabilityCount: tokenCapabilityCount,
            ProcessInPrivateJobBeforeResume: processInPrivateJobBeforeResume,
            PrivateJobActiveProcessCountBeforeResume: privateJobActiveProcessCountBeforeResume,
            ResumeAttempted: resumeAttempted,
            ResumePreviousSuspendCount: resumePreviousSuspendCount,
            PreResumeBoundaryObserved: preResumeBoundaryObserved,
            ProcessExitObserved: processExitObserved,
            ProcessExitCodeZero: processExitCodeZero,
            FixtureJsonParsed: fixtureJsonParsed,
            FixtureStatus: fixtureOutput?.Status,
            FixtureErrorCode: fixtureOutput?.Code,
            FixtureAssertionsPassed: fixtureAssertionsPassed,
            LoopbackConnectDenied: fixtureOutput?.LoopbackConnectDenied,
            LoopbackListenDenied: fixtureOutput?.LoopbackListenDenied,
            LoopbackUdpSendDenied: fixtureOutput?.LoopbackUdpSendDenied,
            LoopbackConnectNativeErrorCode: fixtureOutput?.LoopbackConnectNativeErrorCode,
            LoopbackListenNativeErrorCode: fixtureOutput?.LoopbackListenNativeErrorCode,
            LoopbackUdpSendNativeErrorCode: fixtureOutput?.LoopbackUdpSendNativeErrorCode,
            ChildAttemptsPerMode: fixtureOutput?.ChildAttemptsPerMode,
            NormalChildNativeDenied: fixtureOutput?.NormalChildNativeDenied,
            NormalChildTerminatedBeforeMarker: fixtureOutput?.NormalChildTerminatedBeforeMarker,
            NormalChildMarkerObserved: fixtureOutput?.NormalChildMarkerObserved,
            NormalChildUnexpected: fixtureOutput?.NormalChildUnexpected,
            BreakawayChildNativeDenied: fixtureOutput?.BreakawayChildNativeDenied,
            BreakawayChildTerminatedBeforeMarker: fixtureOutput?.BreakawayChildTerminatedBeforeMarker,
            BreakawayChildMarkerObserved: fixtureOutput?.BreakawayChildMarkerObserved,
            BreakawayChildUnexpected: fixtureOutput?.BreakawayChildUnexpected,
            PrivateJobTotalProcessCountAfterExit: privateJobTotalProcessCountAfterExit,
            PrivateJobActiveProcessCountAfterExit: privateJobActiveProcessCountAfterExit,
            LoopbackAppContainerConnectionAbsent: loopbackAppContainerConnectionAbsent,
            LoopbackAppContainerDatagramAbsent: loopbackAppContainerDatagramAbsent,
            CanaryContentUnchanged: canaryContentUnchanged,
            ForbiddenStagingWriteAbsent: forbiddenStagingWriteAbsent,
            JobTerminationAttempted: jobTerminationAttempted,
            JobTerminationSucceeded: jobTerminationSucceeded,
            JobDrained: jobDrained,
            ProcessCleanupConfirmed: processCleanupConfirmed,
            StagingAclRestored: stagingAclRestored,
            StagedFixtureRemoved: stagedFixtureRemoved,
            AllowedFileRemoved: allowedFileRemoved,
            ForbiddenStagingWriteRemoved: forbiddenStagingWriteRemoved,
            StagingDirectoryRemoved: stagingDirectoryRemoved,
            CanaryFileRemoved: canaryFileRemoved,
            CanaryDirectoryRemoved: canaryDirectoryRemoved,
            SidFreed: sidFreed,
            DeleteAttempts: deleteAttempts,
            ProfileDeleteSucceeded: profileDeleteSucceeded,
            ProfileFolderResidueAbsent: profileFolderResidueAbsent,
            MappingRegistryResidueAbsent: mappingRegistryResidueAbsent,
            StorageRegistryResidueAbsent: storageRegistryResidueAbsent,
            CleanupConfirmed: cleanupConfirmed,
            ProductionBackendAvailable: false);
    }

    private static readonly JsonSerializerOptions BoundaryFixtureJsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    private static string ValidateBoundaryProfileName(string profileName)
    {
        Match match = BoundaryProfileNamePattern().Match(profileName);
        if (!match.Success || profileName.Length > 64)
        {
            throw new ArgumentException("invalid-boundary-proof-name", nameof(profileName));
        }

        return match.Groups[1].Value;
    }

    private static string ValidateBoundaryRoot(
        string root,
        string prefix,
        string token,
        string parameterName)
    {
        string canonical = Path.GetFullPath(root);
        string tempRoot = Path.TrimEndingDirectorySeparator(Path.GetFullPath(Path.GetTempPath()));
        if (
            !string.Equals(Path.GetDirectoryName(canonical), tempRoot, StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(Path.GetFileName(canonical), $"{prefix}{token}", StringComparison.Ordinal))
        {
            throw new ArgumentException("invalid-boundary-proof-root", parameterName);
        }

        return canonical;
    }

    private static string ValidateBoundaryFixture(string fixtureSource, string expectedSha256)
    {
        string canonical = Path.GetFullPath(fixtureSource);
        if (
            !Path.IsPathFullyQualified(fixtureSource) ||
            !File.Exists(canonical) ||
            !string.Equals(
                Path.GetFileName(canonical),
                BoundaryFixtureFileName,
                StringComparison.Ordinal) ||
            !BoundarySha256Pattern().IsMatch(expectedSha256) ||
            (File.GetAttributes(canonical) & FileAttributes.ReparsePoint) != 0 ||
            !string.Equals(HashFile(canonical), expectedSha256, StringComparison.Ordinal))
        {
            throw new ArgumentException("invalid-boundary-fixture", nameof(fixtureSource));
        }

        return canonical;
    }

    private static void ConfigureCanaryAcl(DirectoryInfo directory)
    {
        SecurityIdentifier currentUser = WindowsIdentity.GetCurrent().User ??
            throw new ProofException("current-user-sid-unavailable");
        var security = new DirectorySecurity();
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        security.SetOwner(currentUser);
        security.AddAccessRule(
            new FileSystemAccessRule(
                currentUser,
                FileSystemRights.FullControl,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
                PropagationFlags.None,
                AccessControlType.Allow));
        directory.SetAccessControl(security);
    }

    private static nint CreateBoundaryEnvironment(
        string stagedFixture,
        string profileFolder,
        string stagingRoot)
    {
        string systemRoot = Path.GetFullPath(
            Environment.GetFolderPath(Environment.SpecialFolder.Windows));
        string systemDrive = Path.TrimEndingDirectorySeparator(
            Path.GetPathRoot(systemRoot) ??
            throw new ProofException("system-drive-resolution-failed"));
        string stagingDrive = Path.TrimEndingDirectorySeparator(
            Path.GetPathRoot(stagingRoot) ??
            throw new ProofException("staging-drive-resolution-failed"));
        string profileTemp = Path.Combine(profileFolder, "Temp");
        string block = string.Join(
            '\0',
            $"={stagingDrive}={stagingRoot}",
            $"COMSPEC={stagedFixture}",
            $"DOTNET_BUNDLE_EXTRACT_BASE_DIR={Path.Combine(profileFolder, "Bundle")}",
            $"LOCALAPPDATA={profileFolder}",
            $"SystemDrive={systemDrive}",
            $"SystemRoot={systemRoot}",
            $"TEMP={profileTemp}",
            $"TMP={profileTemp}",
            $"WINDIR={systemRoot}") + '\0';
        return Marshal.StringToHGlobalUni(block);
    }

    private static char[] BuildBoundaryCommandLine(
        string stagedFixture,
        string allowedFile,
        string canaryFile,
        string forbiddenStagingWrite,
        int loopbackPort)
    {
        string commandLine = string.Join(
            ' ',
            QuoteWindowsArgument(stagedFixture),
            "probe",
            QuoteWindowsArgument(allowedFile),
            QuoteWindowsArgument(canaryFile),
            QuoteWindowsArgument(forbiddenStagingWrite),
            loopbackPort.ToString(CultureInfo.InvariantCulture),
            BoundaryChildAttempts.ToString(CultureInfo.InvariantCulture));
        return (commandLine + '\0').ToCharArray();
    }

    private static string QuoteWindowsArgument(string value)
    {
        var output = new StringBuilder(value.Length + 2);
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

    private static string ReadBoundaryFixtureOutput(nint readHandle)
    {
        byte[] output = new byte[MaximumFixtureOutputBytes];
        EnsureWin32(
            ReadFile(
                readHandle,
                output,
                checked((uint)output.Length),
                out uint bytesRead,
                0),
            "structured-boundary-output-read-failed");
        return Encoding.UTF8.GetString(output, 0, checked((int)bytesRead)).Trim();
    }

    private static bool FixtureOutputPassed(BoundaryFixtureOutput? output) =>
        output is
        {
            SchemaVersion: 1,
            Status: "passed",
            AllowedReadSucceeded: true,
            AllowedContentMatched: true,
            StagingWriteDenied: true,
            CanaryReadDenied: true,
            CanaryWriteDenied: true,
            LoopbackConnectDenied: true,
            ChildAttemptsPerMode: BoundaryChildAttempts,
            NormalChildMarkerObserved: 0,
            NormalChildUnexpected: 0,
            BreakawayChildMarkerObserved: 0,
            BreakawayChildUnexpected: 0,
            NormalChildrenBlocked: true,
            BreakawayChildrenBlocked: true,
        };

    private static void DeleteExactFile(string path, ref bool removed)
    {
        if (File.Exists(path))
        {
            File.Delete(path);
        }

        removed = !File.Exists(path);
    }

    [GeneratedRegex(
        "^AiDevOs\\.Stage17\\.BoundaryProof\\.([a-f0-9]{32})$",
        RegexOptions.CultureInvariant)]
    private static partial Regex BoundaryProfileNamePattern();

    [GeneratedRegex("^[a-f0-9]{64}$", RegexOptions.CultureInvariant)]
    private static partial Regex BoundarySha256Pattern();

    private sealed record BoundaryFixtureOutput(
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
        bool BreakawayChildrenBlocked,
        string? Code = null);
}

internal sealed record StructuredBoundaryProofResult(
    int SchemaVersion,
    int ProtocolVersion,
    string Status,
    string Reason,
    int? NativeErrorCode,
    string ProfileNameFingerprint,
    string? ProfileSidFingerprint,
    string StagingRootFingerprint,
    string CanaryRootFingerprint,
    string SourceFixtureSha256,
    string? StagedFixtureSha256,
    bool ProfileCreated,
    bool CapabilitiesRequested,
    bool ProfileFolderObserved,
    bool MappingRegistryObserved,
    bool StorageRegistryObserved,
    bool StagingDirectoryCreated,
    bool StagingAclGrantObserved,
    bool FixtureAclGrantObserved,
    bool AllowedFileAclGrantObserved,
    bool CanaryDirectoryCreated,
    bool CanaryAclProtected,
    bool CanarySidRuleAbsent,
    bool SourceFixtureIsReparsePoint,
    bool StagedFixtureCopied,
    bool StagedFixtureBytesMatched,
    bool JobCreated,
    bool KillOnJobCloseConfigured,
    bool ActiveProcessLimitConfigured,
    bool BreakawayAllowed,
    int CreationAttributeCount,
    int InheritedHandleCount,
    int MinimalEnvironmentEntryCount,
    bool LoopbackOnly,
    bool PublicNetworkAttempted,
    bool LoopbackPositiveControlPassed,
    bool ProcessCreationAttempted,
    bool ProcessCreated,
    bool CreatedSuspended,
    bool AppContainerTokenObserved,
    bool ProfileSidMatched,
    int? TokenCapabilityCount,
    bool ProcessInPrivateJobBeforeResume,
    uint? PrivateJobActiveProcessCountBeforeResume,
    bool ResumeAttempted,
    uint? ResumePreviousSuspendCount,
    bool PreResumeBoundaryObserved,
    bool ProcessExitObserved,
    bool ProcessExitCodeZero,
    bool FixtureJsonParsed,
    string? FixtureStatus,
    string? FixtureErrorCode,
    bool FixtureAssertionsPassed,
    bool? LoopbackConnectDenied,
    bool? LoopbackListenDenied,
    bool? LoopbackUdpSendDenied,
    int? LoopbackConnectNativeErrorCode,
    int? LoopbackListenNativeErrorCode,
    int? LoopbackUdpSendNativeErrorCode,
    int? ChildAttemptsPerMode,
    int? NormalChildNativeDenied,
    int? NormalChildTerminatedBeforeMarker,
    int? NormalChildMarkerObserved,
    int? NormalChildUnexpected,
    int? BreakawayChildNativeDenied,
    int? BreakawayChildTerminatedBeforeMarker,
    int? BreakawayChildMarkerObserved,
    int? BreakawayChildUnexpected,
    uint? PrivateJobTotalProcessCountAfterExit,
    uint? PrivateJobActiveProcessCountAfterExit,
    bool LoopbackAppContainerConnectionAbsent,
    bool LoopbackAppContainerDatagramAbsent,
    bool CanaryContentUnchanged,
    bool ForbiddenStagingWriteAbsent,
    bool JobTerminationAttempted,
    bool JobTerminationSucceeded,
    bool JobDrained,
    bool ProcessCleanupConfirmed,
    bool StagingAclRestored,
    bool StagedFixtureRemoved,
    bool AllowedFileRemoved,
    bool ForbiddenStagingWriteRemoved,
    bool StagingDirectoryRemoved,
    bool CanaryFileRemoved,
    bool CanaryDirectoryRemoved,
    bool SidFreed,
    int DeleteAttempts,
    bool ProfileDeleteSucceeded,
    bool ProfileFolderResidueAbsent,
    bool MappingRegistryResidueAbsent,
    bool StorageRegistryResidueAbsent,
    bool CleanupConfirmed,
    bool ProductionBackendAvailable);

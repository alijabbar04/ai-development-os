using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace AiDevOs.WindowsRuntime;

/// <summary>
/// Holds the complete, installer-produced Stage 17W runtime closure open with
/// write and delete sharing denied.  The lease is acquired from the current
/// image, never from a caller-supplied path, and remains live through every
/// dependent CreateProcessW call.
/// </summary>
internal sealed class RuntimeClosureLease : IDisposable
{
    internal const string CandidateId = "stage17w-runtime-v1";
    internal const string InstalledManifestFileName = "stage17-proof-manifest.json";
    internal const string InstallRecordFileName = "stage17-proof-install-record.json";

    private const int MaximumFileCount = 256;
    private const long MaximumFileBytes = 268_435_456L;
    private readonly Dictionary<string, RuntimeClosureMember> members;
    private readonly List<FileStream> retainedHandles;
    private bool disposed;

    private RuntimeClosureLease(
        string runToken,
        string root,
        Dictionary<string, RuntimeClosureMember> members,
        List<FileStream> retainedHandles)
    {
        RunToken = runToken;
        Root = root;
        this.members = members;
        this.retainedHandles = retainedHandles;
    }

    internal string RunToken { get; }

    internal string Root { get; }

    internal int RetainedHandleCount => retainedHandles.Count;

    internal static bool RunReadOnlySelfTest()
    {
        List<RuntimeClosureMember> fixture =
        [
            new("alpha.dll", 1, new string('a', 64)),
            new("beta.exe", 2, new string('b', 64)),
        ];
        return string.Equals(
            SourceEnvelopeFingerprint(fixture),
            "d804d19ca6e350c7684f17a67aa14a56ef1ca1377b175eec33f1514d045edad7",
            StringComparison.Ordinal);
    }

    internal static string DeriveScenarioToken(string runToken, int index)
    {
        ValidateRunToken(runToken);
        if (index is < 0 or >= 8)
        {
            throw new RuntimeClosureException("scenario-index-invalid");
        }

        byte[] material = Encoding.UTF8.GetBytes(
            $"ai-dev-os/stage17w/scenario/v1/{runToken}/{index.ToString(CultureInfo.InvariantCulture)}");
        byte[] digest = SHA256.HashData(material);
        return Convert.ToHexString(digest.AsSpan(0, 16)).ToLowerInvariant();
    }

    internal static RuntimeClosureLease AcquireFromCurrentImage(string expectedImageName)
    {
        string currentImage = Path.GetFullPath(
            Environment.ProcessPath ?? throw new RuntimeClosureException("current-image-unavailable"));
        if (!string.Equals(Path.GetFileName(currentImage), expectedImageName, StringComparison.Ordinal))
        {
            throw new RuntimeClosureException("current-image-name-mismatch");
        }

        string root = Path.GetDirectoryName(currentImage) ??
            throw new RuntimeClosureException("current-image-root-unavailable");
        string runToken = Path.GetFileName(root);
        ValidateRunToken(runToken);
        ValidateInstalledRoot(root, runToken);
        return Acquire(root, runToken, expectedImageName, expectedSourceEnvelopeFingerprint: null);
    }

    /// <summary>
    /// Proof-controller entry point. The caller supplies only the 128-bit run
    /// token; the ProgramData path and every ancestor are recomputed here.
    /// </summary>
    internal static RuntimeClosureLease AcquireInstalled(
        string runToken,
        string requiredImageName,
        string expectedSourceEnvelopeFingerprint)
    {
        ValidateRunToken(runToken);
        if (!IsSha256(expectedSourceEnvelopeFingerprint))
        {
            throw new RuntimeClosureException("source-envelope-fingerprint-invalid");
        }

        string programData = Path.TrimEndingDirectorySeparator(Path.GetFullPath(
            Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData)));
        string root = Path.Combine(programData, "AI-Dev-OS", "Stage17-Proof", runToken);
        ValidateInstalledRoot(root, runToken);
        return Acquire(root, runToken, requiredImageName, expectedSourceEnvelopeFingerprint);
    }

    internal string AuthorizeImage(string fileName)
    {
        AssertOpen();
        if (!members.ContainsKey(fileName) || !IsSafeFileName(fileName))
        {
            throw new RuntimeClosureException("closure-image-not-verified");
        }

        string combined = Path.Combine(Root, fileName);
        string full = Path.GetFullPath(combined);
        if (!string.Equals(combined, full, StringComparison.Ordinal) ||
            !string.Equals(Path.GetDirectoryName(full), Root, StringComparison.Ordinal))
        {
            throw new RuntimeClosureException("closure-image-path-invalid");
        }

        return full;
    }

    internal string DigestOf(string fileName)
    {
        AssertOpen();
        return members.TryGetValue(fileName, out RuntimeClosureMember? member)
            ? member.Sha256
            : throw new RuntimeClosureException("closure-member-not-verified");
    }

    internal long SizeOf(string fileName)
    {
        AssertOpen();
        return members.TryGetValue(fileName, out RuntimeClosureMember? member)
            ? member.Size
            : throw new RuntimeClosureException("closure-member-not-verified");
    }

    internal bool Contains(string fileName)
    {
        AssertOpen();
        return members.ContainsKey(fileName);
    }

    internal void AssertOpen()
    {
        if (disposed || retainedHandles.Count != members.Count + 2)
        {
            throw new RuntimeClosureException("closure-lease-not-held");
        }

        foreach (FileStream handle in retainedHandles)
        {
            if (handle.SafeFileHandle.IsClosed || handle.SafeFileHandle.IsInvalid)
            {
                throw new RuntimeClosureException("closure-handle-closed");
            }
        }
    }

    public void Dispose()
    {
        if (disposed)
        {
            return;
        }

        disposed = true;
        foreach (FileStream handle in retainedHandles)
        {
            handle.Dispose();
        }
    }

    private static RuntimeClosureLease Acquire(
        string root,
        string runToken,
        string requiredImageName,
        string? expectedSourceEnvelopeFingerprint)
    {
        List<FileStream> handles = [];
        try
        {
            string manifestPath = ExactChild(root, InstalledManifestFileName);
            FileStream manifestHandle = OpenRetained(manifestPath);
            handles.Add(manifestHandle);
            byte[] manifestBytes = ReadBounded(manifestHandle, 1_048_576);
            List<RuntimeClosureMember> parsed = ParseManifest(manifestBytes, runToken);

            var members = new Dictionary<string, RuntimeClosureMember>(StringComparer.Ordinal);
            var caseInsensitive = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            string? previous = null;
            foreach (RuntimeClosureMember member in parsed)
            {
                if (!IsSafeFileName(member.Name) ||
                    !caseInsensitive.Add(member.Name) ||
                    !members.TryAdd(member.Name, member) ||
                    (previous is not null && string.CompareOrdinal(previous, member.Name) >= 0))
                {
                    throw new RuntimeClosureException("manifest-file-set-invalid");
                }

                previous = member.Name;
            }

            if (members.Count is < 3 or > MaximumFileCount ||
                !members.ContainsKey(requiredImageName) ||
                !members.ContainsKey("AI.DevOS.WindowsSupervisor.exe") ||
                !members.ContainsKey("AI.DevOS.WindowsHelper.exe") ||
                !members.ContainsKey("AI.DevOS.WindowsBoundaryFixture.exe"))
            {
                throw new RuntimeClosureException("manifest-required-image-missing");
            }

            string installRecordPath = ExactChild(root, InstallRecordFileName);
            FileStream recordHandle = OpenRetained(installRecordPath);
            handles.Add(recordHandle);
            ValidateInstallRecord(ReadBounded(recordHandle, 65_536), runToken);

            HashSet<string> expected = new(members.Keys, StringComparer.Ordinal);
            expected.Add(InstalledManifestFileName);
            expected.Add(InstallRecordFileName);
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (string entry in Directory.EnumerateFileSystemEntries(root))
            {
                string name = Path.GetFileName(entry);
                FileAttributes attributes = File.GetAttributes(entry);
                if ((attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0 ||
                    !expected.Contains(name) ||
                    !seen.Add(name))
                {
                    throw new RuntimeClosureException("installed-closure-unexpected-entry");
                }
            }

            if (seen.Count != expected.Count)
            {
                throw new RuntimeClosureException("installed-closure-missing-entry");
            }

            foreach (RuntimeClosureMember member in parsed)
            {
                string path = ExactChild(root, member.Name);
                if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
                {
                    throw new RuntimeClosureException("installed-closure-reparse-point");
                }

                FileStream handle = OpenRetained(path);
                handles.Add(handle);
                if (handle.Length != member.Size || member.Size is < 1 or > MaximumFileBytes)
                {
                    throw new RuntimeClosureException("installed-closure-size-mismatch");
                }

                string measured = HashHandle(handle);
                if (!string.Equals(measured, member.Sha256, StringComparison.Ordinal))
                {
                    throw new RuntimeClosureException("installed-closure-digest-mismatch");
                }
            }

            if (expectedSourceEnvelopeFingerprint is not null &&
                !string.Equals(
                    SourceEnvelopeFingerprint(parsed),
                    expectedSourceEnvelopeFingerprint,
                    StringComparison.Ordinal))
            {
                throw new RuntimeClosureException("installed-source-envelope-unreviewed");
            }

            var lease = new RuntimeClosureLease(runToken, root, members, handles);
            lease.AssertOpen();
            handles = [];
            return lease;
        }
        finally
        {
            foreach (FileStream handle in handles)
            {
                handle.Dispose();
            }
        }
    }

    private static List<RuntimeClosureMember> ParseManifest(
        byte[] bytes,
        string runToken)
    {
        using JsonDocument document = JsonDocument.Parse(
            bytes,
            new JsonDocumentOptions { AllowTrailingCommas = false, CommentHandling = JsonCommentHandling.Disallow });
        JsonElement root = document.RootElement;
        RequireObjectShape(root, ["candidateId", "files", "manifestKind", "runToken", "schemaVersion"]);
        if (root.GetProperty("schemaVersion").GetInt32() != 1 ||
            !string.Equals(root.GetProperty("manifestKind").GetString(),
                "ai-dev-os-stage17-proof-installed-manifest", StringComparison.Ordinal) ||
            !string.Equals(root.GetProperty("candidateId").GetString(), CandidateId, StringComparison.Ordinal) ||
            !string.Equals(root.GetProperty("runToken").GetString(), runToken, StringComparison.Ordinal))
        {
            throw new RuntimeClosureException("installed-manifest-identity-mismatch");
        }

        JsonElement files = root.GetProperty("files");
        if (files.ValueKind != JsonValueKind.Array)
        {
            throw new RuntimeClosureException("installed-manifest-files-invalid");
        }

        List<RuntimeClosureMember> result = [];
        foreach (JsonElement file in files.EnumerateArray())
        {
            RequireObjectShape(file, ["name", "sha256", "size"]);
            string name = file.GetProperty("name").GetString() ?? string.Empty;
            string sha256 = file.GetProperty("sha256").GetString() ?? string.Empty;
            long size = file.GetProperty("size").GetInt64();
            if (!IsSafeFileName(name) || !IsSha256(sha256) || size is < 1 or > MaximumFileBytes)
            {
                throw new RuntimeClosureException("installed-manifest-file-invalid");
            }

            result.Add(new RuntimeClosureMember(name, size, sha256));
        }

        return result;
    }

    private static void ValidateInstallRecord(byte[] bytes, string runToken)
    {
        using JsonDocument document = JsonDocument.Parse(
            bytes,
            new JsonDocumentOptions { AllowTrailingCommas = false, CommentHandling = JsonCommentHandling.Disallow });
        JsonElement root = document.RootElement;
        RequireObjectShape(root, ["leafIdentity", "recordKind", "runToken", "schemaVersion"]);
        if (root.GetProperty("schemaVersion").GetInt32() != 1 ||
            !string.Equals(root.GetProperty("recordKind").GetString(),
                "ai-dev-os-stage17-proof-install-record", StringComparison.Ordinal) ||
            !string.Equals(root.GetProperty("runToken").GetString(), runToken, StringComparison.Ordinal) ||
            string.IsNullOrWhiteSpace(root.GetProperty("leafIdentity").GetString()))
        {
            throw new RuntimeClosureException("install-record-invalid");
        }
    }

    private static void RequireObjectShape(JsonElement element, IReadOnlyList<string> expected)
    {
        if (element.ValueKind != JsonValueKind.Object)
        {
            throw new RuntimeClosureException("json-object-required");
        }

        var remaining = new HashSet<string>(expected, StringComparer.Ordinal);
        int count = 0;
        foreach (JsonProperty property in element.EnumerateObject())
        {
            count++;
            if (!remaining.Remove(property.Name))
            {
                throw new RuntimeClosureException("json-object-shape-invalid");
            }
        }

        if (count != expected.Count || remaining.Count != 0)
        {
            throw new RuntimeClosureException("json-object-shape-invalid");
        }
    }

    private static FileStream OpenRetained(string path) =>
        new(path, FileMode.Open, FileAccess.Read, FileShare.Read, 64 * 1024, FileOptions.SequentialScan);

    private static byte[] ReadBounded(FileStream handle, int maximum)
    {
        if (handle.Length is < 1 || handle.Length > maximum)
        {
            throw new RuntimeClosureException("closure-metadata-size-invalid");
        }

        handle.Position = 0;
        byte[] bytes = new byte[checked((int)handle.Length)];
        int offset = 0;
        while (offset < bytes.Length)
        {
            int read = handle.Read(bytes, offset, bytes.Length - offset);
            if (read == 0)
            {
                throw new RuntimeClosureException("closure-metadata-truncated");
            }

            offset = checked(offset + read);
        }

        handle.Position = 0;
        return bytes;
    }

    private static string HashHandle(FileStream handle)
    {
        handle.Position = 0;
        byte[] digest = SHA256.HashData(handle);
        handle.Position = 0;
        return Convert.ToHexString(digest).ToLowerInvariant();
    }

    private static string SourceEnvelopeFingerprint(
        IReadOnlyList<RuntimeClosureMember> members)
    {
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer, new JsonWriterOptions { Indented = false }))
        {
            writer.WriteStartObject();
            writer.WriteString("buildFlavor", "sealed");
            writer.WriteString("bundleVersion", "1.0.0");
            writer.WriteString("component", "windows-stage17-runtime");
            writer.WriteStartArray("files");
            foreach (RuntimeClosureMember member in members)
            {
                writer.WriteStartObject();
                writer.WriteString("name", member.Name);
                writer.WriteString("sha256", member.Sha256);
                writer.WriteNumber("size", member.Size);
                writer.WriteEndObject();
            }

            writer.WriteEndArray();
            writer.WriteNumber("schemaVersion", 1);
            writer.WriteEndObject();
            writer.Flush();
        }

        return Convert.ToHexString(SHA256.HashData(buffer.ToArray())).ToLowerInvariant();
    }

    private static string ExactChild(string root, string name)
    {
        if (!IsSafeFileName(name))
        {
            throw new RuntimeClosureException("closure-file-name-invalid");
        }

        string combined = Path.Combine(root, name);
        string full = Path.GetFullPath(combined);
        if (!string.Equals(combined, full, StringComparison.Ordinal) ||
            !string.Equals(Path.GetDirectoryName(full), root, StringComparison.Ordinal))
        {
            throw new RuntimeClosureException("closure-child-path-invalid");
        }

        return full;
    }

    private static void ValidateInstalledRoot(string root, string runToken)
    {
        string programData = Path.TrimEndingDirectorySeparator(Path.GetFullPath(
            Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData)));
        string expected = Path.Combine(programData, "AI-Dev-OS", "Stage17-Proof", runToken);
        if (!string.Equals(root, expected, StringComparison.Ordinal) ||
            !string.Equals(Path.GetFullPath(expected), expected, StringComparison.Ordinal))
        {
            throw new RuntimeClosureException("installed-root-invalid");
        }

        string current = programData;
        foreach (string component in new[] { "AI-Dev-OS", "Stage17-Proof", runToken })
        {
            current = Path.Combine(current, component);
            var info = new DirectoryInfo(current);
            if (!info.Exists || info.LinkTarget is not null ||
                (info.Attributes & FileAttributes.ReparsePoint) != 0)
            {
                throw new RuntimeClosureException("installed-root-reparse-or-missing");
            }
        }
    }

    private static void ValidateRunToken(string token)
    {
        if (token.Length != 32)
        {
            throw new RuntimeClosureException("run-token-invalid");
        }

        foreach (char value in token)
        {
            if (value is not (>= '0' and <= '9') and not (>= 'a' and <= 'f'))
            {
                throw new RuntimeClosureException("run-token-invalid");
            }
        }
    }

    private static bool IsSha256(string value)
    {
        if (value.Length != 64)
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

    private static bool IsSafeFileName(string value)
    {
        if (value.Length is < 1 or > 128 || value is "." or ".." || value.Contains("..", StringComparison.Ordinal))
        {
            return false;
        }

        for (int index = 0; index < value.Length; index++)
        {
            char character = value[index];
            bool accepted =
                (character >= 'A' && character <= 'Z') ||
                (character >= 'a' && character <= 'z') ||
                (character >= '0' && character <= '9') ||
                (index > 0 && character is '.' or '_' or '-');
            if (!accepted)
            {
                return false;
            }
        }

        return true;
    }
}

internal sealed record RuntimeClosureMember(string Name, long Size, string Sha256);

internal sealed class RuntimeClosureException : Exception
{
    internal RuntimeClosureException(string code)
        : base(code)
    {
        Code = code;
    }

    internal string Code { get; }
}

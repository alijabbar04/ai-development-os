using System;
using System.Collections.Generic;
using System.IO;

namespace AiDevOs.WindowsSupervisor;

/// <summary>
/// The narrow set of filesystem facts path resolution needs.
///
/// It is an interface for one reason only: so the read-only self-test can drive
/// every refusal in <see cref="BundleRootResolver"/> — reparse points, escapes,
/// case-only duplicates, ambiguous normalization — against an in-memory
/// description of a hostile layout, without creating that layout on the host.
/// The production implementation is <see cref="Win32PathFacts"/> and is the
/// only one that touches a disk.
/// </summary>
internal interface IPathFacts
{
    bool DirectoryExists(string absolutePath);

    bool IsReparsePoint(string absolutePath);

    /// <summary>
    /// The names of the entries directly inside a directory, exactly as the
    /// filesystem spells them. Case matters: the resolver compares the spelling
    /// the filesystem reports against the spelling the manifest requested, so a
    /// case-only difference is caught rather than silently accepted by a
    /// case-insensitive open.
    /// </summary>
    IReadOnlyList<string> EnumerateEntryNames(string absoluteDirectory);
}

/// <summary>The production facts source. Read-only; it creates nothing.</summary>
internal sealed class Win32PathFacts : IPathFacts
{
    internal static Win32PathFacts Instance { get; } = new();

    public bool DirectoryExists(string absolutePath) => Directory.Exists(absolutePath);

    public bool IsReparsePoint(string absolutePath)
    {
        try
        {
            FileSystemInfo info = Directory.Exists(absolutePath)
                ? new DirectoryInfo(absolutePath)
                : new FileInfo(absolutePath);
            if (!info.Exists)
            {
                return false;
            }

            return info.LinkTarget is not null ||
                (info.Attributes & FileAttributes.ReparsePoint) == FileAttributes.ReparsePoint;
        }
        catch (IOException)
        {
            // An unreadable component is treated as a reparse point: refusing is
            // the safe interpretation of "cannot prove this is a plain
            // directory".
            return true;
        }
        catch (UnauthorizedAccessException)
        {
            return true;
        }
    }

    public IReadOnlyList<string> EnumerateEntryNames(string absoluteDirectory)
    {
        List<string> names = [];
        if (!Directory.Exists(absoluteDirectory))
        {
            return names;
        }

        try
        {
            foreach (string entry in Directory.EnumerateFileSystemEntries(absoluteDirectory))
            {
                names.Add(Path.GetFileName(entry));
            }
        }
        catch (IOException)
        {
            return [];
        }
        catch (UnauthorizedAccessException)
        {
            return [];
        }

        names.Sort(StringComparer.Ordinal);
        return names;
    }
}

/// <summary>
/// An in-memory layout used only by the read-only self-test. Every directory,
/// reparse point, and entry name is declared explicitly, so a hostile layout can
/// be described without ever existing.
/// </summary>
internal sealed class InMemoryPathFacts : IPathFacts
{
    private readonly HashSet<string> directories = new(StringComparer.OrdinalIgnoreCase);
    private readonly HashSet<string> reparsePoints = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, List<string>> entries = new(StringComparer.OrdinalIgnoreCase);

    internal InMemoryPathFacts AddDirectory(string absolutePath)
    {
        directories.Add(absolutePath);
        return this;
    }

    internal InMemoryPathFacts AddReparsePoint(string absolutePath)
    {
        directories.Add(absolutePath);
        reparsePoints.Add(absolutePath);
        return this;
    }

    internal InMemoryPathFacts AddEntries(string absoluteDirectory, params string[] names)
    {
        directories.Add(absoluteDirectory);
        if (!entries.TryGetValue(absoluteDirectory, out List<string>? list))
        {
            list = [];
            entries[absoluteDirectory] = list;
        }

        list.AddRange(names);
        return this;
    }

    public bool DirectoryExists(string absolutePath) => directories.Contains(absolutePath);

    public bool IsReparsePoint(string absolutePath) => reparsePoints.Contains(absolutePath);

    public IReadOnlyList<string> EnumerateEntryNames(string absoluteDirectory) =>
        entries.TryGetValue(absoluteDirectory, out List<string>? list) ? list : [];
}

/// <summary>
/// A bundle root that has been resolved, proved free of reparse points, proved
/// to be inside the approved installation root, and enumerated exactly once.
///
/// Nothing downstream re-derives a path from caller input: member paths are
/// produced only by <see cref="TryResolveMemberPath"/>, which appends a name
/// that has already been proved to be a plain, separator-free, closed-class
/// file name to a directory that has already been proved safe.
/// </summary>
internal sealed class ResolvedBundleRoot
{
    private ResolvedBundleRoot(
        string approvedInstallRoot,
        string absolutePath,
        string component,
        string bundleVersion,
        IReadOnlyList<string> enumeratedFileNames)
    {
        ApprovedInstallRoot = approvedInstallRoot;
        AbsolutePath = absolutePath;
        Component = component;
        BundleVersion = bundleVersion;
        EnumeratedFileNames = enumeratedFileNames;
    }

    internal string ApprovedInstallRoot { get; }

    internal string AbsolutePath { get; }

    internal string Component { get; }

    internal string BundleVersion { get; }

    internal IReadOnlyList<string> EnumeratedFileNames { get; }

    internal bool TryResolveMemberPath(string name, out string absolutePath, out RefusalCode code)
    {
        absolutePath = string.Empty;

        // The name has to survive the same closed-class check the manifest
        // reader applies. A separator, a drive letter, a dot segment, a stream
        // name, or a reserved device name never reaches Path.Combine.
        if (!ArtifactManifestReader.IsAcceptableFileName(name))
        {
            code = RefusalCode.ManifestFileNameInvalid;
            return false;
        }

        string combined = Path.Combine(AbsolutePath, name);
        string full = Path.GetFullPath(combined);

        // Belt and braces: even with a validated name, the composed path must
        // still be a direct child of the resolved root. If normalization ever
        // moved it, that is an escape.
        if (!string.Equals(combined, full, StringComparison.Ordinal) ||
            !string.Equals(Path.GetDirectoryName(full), AbsolutePath, StringComparison.Ordinal))
        {
            code = RefusalCode.ArtifactPathEscape;
            return false;
        }

        absolutePath = full;
        code = RefusalCode.None;
        return true;
    }

    internal CanonicalObject ToCanonical() =>
        new CanonicalObject()
            .Set("bundleVersion", BundleVersion)
            .Set("component", Component)
            .Set("fileCount", EnumeratedFileNames.Count)
            .Set("fileNames", EnumeratedFileNames);

    internal static ResolvedBundleRoot ForTesting(
        string approvedInstallRoot,
        string absolutePath,
        string component,
        string bundleVersion,
        IReadOnlyList<string> enumeratedFileNames) =>
        new(approvedInstallRoot, absolutePath, component, bundleVersion, enumeratedFileNames);

    internal static ResolvedBundleRoot Create(
        string approvedInstallRoot,
        string absolutePath,
        string component,
        string bundleVersion,
        IReadOnlyList<string> enumeratedFileNames) =>
        new(approvedInstallRoot, absolutePath, component, bundleVersion, enumeratedFileNames);
}

/// <summary>
/// Resolves <c>&lt;installRoot&gt;/&lt;component&gt;/&lt;bundleVersion&gt;/win-x64</c>
/// (ADR 0017 section 6.1) and refuses everything ambiguous.
///
/// The resolver never accepts a caller-supplied bundle path. It accepts an
/// approved installation root plus a component and a version, and composes the
/// rest itself, so there is no string a caller can pass that redirects the
/// lookup.
/// </summary>
internal static class BundleRootResolver
{
    /// <summary>
    /// The fixed RID directory. It is a constant, not a parameter: a bundle for
    /// a different architecture is a different bundle, not a different argument.
    /// </summary>
    internal const string RidDirectoryName = "win-x64";

    internal static bool TryResolve(
        IPathFacts facts,
        string approvedInstallRoot,
        string component,
        string bundleVersion,
        out ResolvedBundleRoot resolved,
        out RefusalCode code)
    {
        resolved = null!;

        if (!IsAcceptableSegment(component) || !IsAcceptableSegment(bundleVersion))
        {
            code = RefusalCode.ArtifactPathNormalizationAmbiguous;
            return false;
        }

        if (!ProtocolMessage.IsAcceptableBundleVersion(bundleVersion))
        {
            code = RefusalCode.ValueOutOfRange;
            return false;
        }

        if (!string.Equals(component, "windows-supervisor", StringComparison.Ordinal) &&
            !string.Equals(component, "windows-helper", StringComparison.Ordinal))
        {
            code = RefusalCode.ManifestIdentityMismatch;
            return false;
        }

        if (!TryNormalizeRoot(approvedInstallRoot, out string root, out code))
        {
            return false;
        }

        string candidate = Path.Combine(root, component, bundleVersion, RidDirectoryName);
        string full = Path.GetFullPath(candidate);

        // Normalization must be a no-op. If GetFullPath changed anything, the
        // input contained a dot segment, a doubled separator, a trailing dot or
        // space, or some other spelling that two components could disagree
        // about. Two spellings of one path is exactly the ambiguity that lets a
        // check and a use diverge.
        if (!string.Equals(candidate, full, StringComparison.Ordinal))
        {
            code = RefusalCode.ArtifactPathNormalizationAmbiguous;
            return false;
        }

        if (!IsInsideRoot(root, full))
        {
            code = RefusalCode.ArtifactPathEscape;
            return false;
        }

        if (!facts.DirectoryExists(full))
        {
            code = RefusalCode.ArtifactRootUnresolvable;
            return false;
        }

        // Every component from the approved root down to the RID directory must
        // be a plain directory. A reparse point anywhere in the chain is the
        // path-redirection surface ADR 0017 section 6.6 records as unsolved, so
        // the one form of it that is detectable is refused outright.
        if (!TryAssertChainIsPlain(facts, root, full, out code))
        {
            return false;
        }

        IReadOnlyList<string> names = facts.EnumerateEntryNames(full);
        if (!TryValidateEnumeratedNames(names, out code))
        {
            return false;
        }

        resolved = ResolvedBundleRoot.Create(root, full, component, bundleVersion, names);
        code = RefusalCode.None;
        return true;
    }

    private static bool TryNormalizeRoot(string approvedInstallRoot, out string root, out RefusalCode code)
    {
        root = string.Empty;
        if (string.IsNullOrEmpty(approvedInstallRoot))
        {
            code = RefusalCode.ArtifactRootUnresolvable;
            return false;
        }

        if (!Path.IsPathFullyQualified(approvedInstallRoot))
        {
            code = RefusalCode.ArtifactRootUnresolvable;
            return false;
        }

        string trimmed = Path.TrimEndingDirectorySeparator(approvedInstallRoot);
        string full = Path.GetFullPath(trimmed);
        if (!string.Equals(trimmed, full, StringComparison.Ordinal))
        {
            code = RefusalCode.ArtifactPathNormalizationAmbiguous;
            return false;
        }

        // A short-name alias ("PROGRA~1") is a second spelling of the same
        // directory and is refused for the same reason as any other ambiguity.
        if (full.Contains('~', StringComparison.Ordinal))
        {
            code = RefusalCode.ArtifactPathNormalizationAmbiguous;
            return false;
        }

        // Only a plain local drive-letter root. This rejects two families that
        // the checks above do not:
        //
        //   \?\C:\...  and  \.\C:\...  are by definition a second spelling of
        //     the same directory, and the \?\ form additionally suppresses
        //     Win32 path normalization, so the "normalization is a no-op" check
        //     above stops meaning what it says; and
        //   \server\share  is remote, which puts the installed bytes on a
        //     machine and a transport this design has never reasoned about.
        if (full.StartsWith(@"\\", StringComparison.Ordinal))
        {
            code = RefusalCode.ArtifactRootUnresolvable;
            return false;
        }

        if (full.Length < 3 ||
            !char.IsAsciiLetter(full[0]) ||
            full[1] != ':' ||
            full[2] != Path.DirectorySeparatorChar)
        {
            code = RefusalCode.ArtifactRootUnresolvable;
            return false;
        }

        root = full;
        code = RefusalCode.None;
        return true;
    }

    /// <summary>
    /// Whether <paramref name="candidate"/> is strictly inside
    /// <paramref name="root"/>, comparing whole path segments rather than a raw
    /// string prefix.
    ///
    /// This is defence in depth and is currently unreachable through
    /// <see cref="TryResolve"/>: the segment and normalization checks above
    /// already make an escaping composition impossible, so deleting this call
    /// changes no observable behaviour. That is exactly why it is exposed and
    /// pinned by its own self-test vectors — an unreachable guard with no test
    /// is indistinguishable from a guard that does not work, and the next
    /// person to add a caller would inherit it untested.
    /// </summary>
    internal static bool IsPathInsideRoot(string root, string candidate) =>
        IsInsideRoot(root, candidate);

    private static bool IsInsideRoot(string root, string candidate)
    {
        if (candidate.Length <= root.Length)
        {
            return false;
        }

        if (!candidate.StartsWith(root, StringComparison.Ordinal))
        {
            return false;
        }

        return candidate[root.Length] == Path.DirectorySeparatorChar;
    }

    private static bool TryAssertChainIsPlain(
        IPathFacts facts,
        string root,
        string leaf,
        out RefusalCode code)
    {
        string current = leaf;
        while (true)
        {
            if (facts.IsReparsePoint(current))
            {
                code = RefusalCode.ArtifactPathReparsePoint;
                return false;
            }

            if (string.Equals(current, root, StringComparison.Ordinal))
            {
                break;
            }

            string? parent = Path.GetDirectoryName(current);
            if (parent is null || string.Equals(parent, current, StringComparison.Ordinal))
            {
                // Walked past the approved root without meeting it. The leaf is
                // not under the root after all.
                code = RefusalCode.ArtifactPathEscape;
                return false;
            }

            current = parent;
        }

        code = RefusalCode.None;
        return true;
    }

    private static bool TryValidateEnumeratedNames(IReadOnlyList<string> names, out RefusalCode code)
    {
        HashSet<string> exact = new(StringComparer.Ordinal);
        HashSet<string> caseInsensitive = new(StringComparer.OrdinalIgnoreCase);
        foreach (string name in names)
        {
            if (!ArtifactManifestReader.IsAcceptableFileName(name))
            {
                code = RefusalCode.ManifestFileNameInvalid;
                return false;
            }

            // Two entries differing only by case cannot both be opened by name
            // on a case-insensitive filesystem: one would silently shadow the
            // other, and which one wins is not something this code should be
            // guessing.
            if (!exact.Add(name) || !caseInsensitive.Add(name))
            {
                code = RefusalCode.ManifestFileDuplicate;
                return false;
            }
        }

        code = RefusalCode.None;
        return true;
    }

    private static bool IsAcceptableSegment(string? value)
    {
        if (string.IsNullOrEmpty(value) || value.Length > 64)
        {
            return false;
        }

        if (value.Contains("..", StringComparison.Ordinal) ||
            value.Contains('~', StringComparison.Ordinal))
        {
            return false;
        }

        foreach (char character in value)
        {
            bool acceptable = char.IsAsciiLetterOrDigit(character) ||
                character == '.' ||
                character == '-';
            if (!acceptable)
            {
                return false;
            }
        }

        return value[^1] != '.' && value[^1] != ' ';
    }
}

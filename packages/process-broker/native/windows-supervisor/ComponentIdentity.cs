namespace AiDevOs.WindowsSupervisor;

/// <summary>
/// The component's own fixed identity. Every value is a compile-time constant
/// baked into reviewed source: none of them is read from the environment, the
/// command line, a configuration file, the registry, or the manifest, so a
/// substituted bundle cannot make a component report an identity it does not
/// have (ADR 0017 section 6.5 step 5).
/// </summary>
internal static class ComponentIdentity
{
    internal const string ComponentName = "windows-supervisor";
    internal const string Role = "supervisor";
    internal const string SourceVersion = "1.0.0";
    internal const int BuildRecipeVersion = 1;
    internal const string RuntimeIdentifier = "win-x64";
    internal const string Platform = "win32";
    internal const string Architecture = "x64";
    internal const string SignerState = ArtifactManifest.UnsignedSignerState;
}

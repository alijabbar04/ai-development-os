namespace AiDevOs.WindowsSupervisor;

/// <summary>
/// The single structural gate in front of every operation that would create
/// native or persistent host state: an AppContainer profile, a Job Object, a
/// process, an ACL change, a registry write, a recovery-journal file, or a
/// staged directory.
/// </summary>
internal static class MutationGate
{
    /// <summary>
    /// Compile-time constant, <see langword="false"/> in this checkpoint.
    ///
    /// Nothing reachable at run time maps to this constant. There is no
    /// command-line argument, environment variable, configuration file,
    /// registry value, protocol field, manifest field, or settable property
    /// that changes it. Enabling a mutating operation requires editing this
    /// line and rebuilding from reviewed source, which is a separately
    /// authorized change and produces a different source-envelope fingerprint.
    /// </summary>
    private const bool MutatingOperationsEnabled = false;

    /// <summary>
    /// Read the gate through a property rather than through the constant
    /// directly. If the constant were tested inline the C# compiler would fold
    /// it and report the (correctly) unreachable mutating branches as CS0162,
    /// which <c>TreatWarningsAsErrors</c> turns into a build failure. The value
    /// is still statically <see langword="false"/>: the property has no setter,
    /// no backing field, and no other source of truth.
    /// </summary>
    internal static bool MutatingOperationsPermitted => MutatingOperationsEnabled;
}

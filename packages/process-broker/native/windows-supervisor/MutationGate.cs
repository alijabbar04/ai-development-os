namespace AiDevOs.WindowsSupervisor;

/// <summary>
/// Proof of a reviewed, separately authorized bounded proof run.
///
/// This type is a capability, not a flag. It has exactly one constructor, that
/// constructor is private, and the only call site in the entire source tree is
/// the accessor below, which is compiled only when the reviewed proof-mode build
/// constant <c>AIDEVOS_STAGE17_REVIEWED_PROOF_MODE</c> is defined.
///
/// The default build recipe (ADR 0017 section 6.2) does not define that
/// constant, so in a production binary the accessor does not exist, the
/// constructor is unreachable, and no instance of this type can come into
/// existence by any means: there is no environment variable, command-line
/// switch, configuration file, registry value, protocol field, manifest field,
/// settable property, reflection-friendly public surface, or caller-supplied
/// value that produces one. Obtaining one requires editing reviewed source and
/// rebuilding with a different, self-identifying build recipe.
/// </summary>
[System.Diagnostics.CodeAnalysis.SuppressMessage(
    "Performance",
    "CA1812:Avoid uninstantiated internal classes",
    Justification =
        "Never being instantiated is this type's entire purpose and the property " +
        "this checkpoint asserts. In a production build the only construction site " +
        "is not compiled, so no instance can exist; the analyzer is observing the " +
        "invariant, not a defect. If this suppression ever becomes unnecessary, a " +
        "proof-mode construction site has been compiled into a production binary.")]
internal sealed class ReviewedProofModeAuthorization
{
    private ReviewedProofModeAuthorization()
    {
    }

#if AIDEVOS_STAGE17_REVIEWED_PROOF_MODE
    /// <summary>
    /// The single construction site. Deliberately not reachable from discovery,
    /// registration, preparation, or spawn: no production code path references
    /// it, and it is not compiled at all in the production recipe.
    /// </summary>
    internal static ReviewedProofModeAuthorization IssueForReviewedBoundedProof() => new();
#endif
}

/// <summary>
/// The single structural gate in front of every operation that would create
/// native or persistent host state: an AppContainer profile, a Job Object, a
/// process, an ACL change, a registry write, a recovery-journal file, or a
/// staged directory.
///
/// The gate is two-factor and both factors must hold:
///
/// 1. the build must have been produced by the reviewed proof-mode recipe
///    (<see cref="ProofModeCompiledIn"/>), and
/// 2. the caller must present a <see cref="ReviewedProofModeAuthorization"/>,
///    which cannot be constructed at all unless factor 1 holds.
///
/// Either factor alone refuses. Both factors are compile-time facts about the
/// source and the recipe, never about the environment the binary runs in.
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

#if AIDEVOS_STAGE17_REVIEWED_PROOF_MODE
    private const bool ProofModeRecipe = true;
    private const string BuildFlavorName = "reviewed-proof-mode";
#else
    private const bool ProofModeRecipe = false;
    private const string BuildFlavorName = "sealed";
#endif

    /// <summary>
    /// Read the gate through a property rather than through the constant
    /// directly. If the constant were tested inline the C# compiler would fold
    /// it and report the (correctly) unreachable mutating branches as CS0162,
    /// which <c>TreatWarningsAsErrors</c> turns into a build failure. The value
    /// is still statically <see langword="false"/>: the property has no setter,
    /// no backing field, and no other source of truth.
    /// </summary>
    internal static bool MutatingOperationsPermitted => MutatingOperationsEnabled;

    /// <summary>Whether this binary was built by the reviewed proof-mode recipe.</summary>
    internal static bool ProofModeCompiledIn => ProofModeRecipe;

    /// <summary>
    /// A self-identifying name for the recipe that produced this binary. It is
    /// reported by <c>self-test</c> and <c>describe-artifact</c> so a
    /// proof-flavoured binary can never be mistaken for a production one by
    /// reading its output.
    /// </summary>
    internal static string BuildFlavor => BuildFlavorName;

    /// <summary>
    /// The single authorization decision. Returns <see cref="RefusalCode.None"/>
    /// only when both factors hold; in this checkpoint it always refuses,
    /// because factor 1 is false and factor 2 is therefore unobtainable.
    /// </summary>
    internal static RefusalCode Authorize(ReviewedProofModeAuthorization? authorization)
    {
        if (authorization is null)
        {
            return RefusalCode.MutatingOperationsStructurallyDisabled;
        }

        return ProofModeCompiledIn ? RefusalCode.None : RefusalCode.ProofModeNotAuthorized;
    }

    /// <summary>
    /// Stamps the gate's observable identity onto an output object.
    ///
    /// Every command that describes this binary calls this, so the field list
    /// exists once. The point is inspectability: a binary built with the
    /// reviewed proof-mode recipe must be distinguishable from a production one
    /// by reading its output, without access to the source or the build logs.
    /// A gate that is strong but invisible cannot be checked by anyone
    /// downstream, and an unobservable property is not an enforceable one.
    /// </summary>
    internal static CanonicalObject Describe(CanonicalObject target) =>
        target
            .Set("buildFlavor", BuildFlavor)
            .Set("proofModeCompiledIn", ProofModeCompiledIn);

    internal static CanonicalObject ToCanonical() =>
        Describe(new CanonicalObject())
            .Set("mutatingOperationsPermitted", MutatingOperationsPermitted)
            .Set("unauthorizedRefusal", ProtocolNames.Of(Authorize(null)));
}

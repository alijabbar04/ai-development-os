namespace AiDevOs.WindowsSupervisor;

/// <summary>
/// Proof of a reviewed, separately authorized bounded proof run.
///
/// This type is a capability, not a flag. It has exactly one constructor, that
/// constructor is private, and the only call site in the entire source tree is
/// the accessor below, which is compiled only when the reviewed proof-mode build
/// constant <c>AIDEVOS_STAGE17_REVIEWED_PROOF_MODE</c> is defined.
///
/// The sealed build recipe (ADR 0018 section 4) does not define that constant,
/// so in a sealed binary the accessor does not exist, the constructor is
/// unreachable, and no instance of this type can come into existence by any
/// means: there is no environment variable, command-line switch, configuration
/// file, registry value, protocol field, manifest field, settable property,
/// reflection-friendly public surface, or caller-supplied value that produces
/// one. Obtaining one requires building with a different, self-identifying
/// build recipe, which produces different bytes and a different closure
/// fingerprint.
/// </summary>
[System.Diagnostics.CodeAnalysis.SuppressMessage(
    "Performance",
    "CA1812:Avoid uninstantiated internal classes",
    Justification =
        "Never being instantiated is this type's entire purpose in a sealed " +
        "build, and the property this checkpoint asserts. In a sealed build the " +
        "only construction site is not compiled, so no instance can exist; the " +
        "analyzer is observing the invariant, not a defect. If this suppression " +
        "ever becomes unnecessary in a SEALED build, a proof-mode construction " +
        "site has been compiled into a production-shaped binary.")]
internal sealed class ReviewedProofModeAuthorization
{
    private ReviewedProofModeAuthorization()
    {
    }

#if AIDEVOS_STAGE17_REVIEWED_PROOF_MODE
    /// <summary>
    /// The single construction site. Deliberately not reachable from discovery,
    /// registration, preparation, or spawn: no production code path references
    /// it, and it is not compiled at all in the sealed recipe.
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
///
/// ADR 0018 section 4 resolved a contradiction that existed here at
/// <c>093203c</c>: <c>MutatingOperationsEnabled</c> used to be unconditionally
/// <see langword="false"/>, so even a reviewed-proof build could not execute a
/// mutating path — the gate was a wall with a door drawn on it. The constant is
/// now bound to the recipe, and the coupling itself is a self-test vector, so
/// setting one without the other is a build failure rather than a silent
/// re-drawing of the door.
/// </summary>
internal static class MutationGate
{
#if AIDEVOS_STAGE17_REVIEWED_PROOF_MODE
    private const bool ProofModeRecipe = true;
    private const string BuildFlavorName = "reviewed-proof-mode";

    /// <summary>
    /// Compile-time constant. Nothing reachable at run time maps to it: there
    /// is no command-line argument, environment variable, configuration file,
    /// registry value, protocol field, manifest field, or settable property
    /// that changes it. It is <see langword="true"/> only in this branch, which
    /// exists only when the reviewed proof-mode recipe compiled the file.
    /// </summary>
    private const bool MutatingOperationsEnabled = true;
#else
    private const bool ProofModeRecipe = false;
    private const string BuildFlavorName = "sealed";

    /// <summary>
    /// Compile-time constant, <see langword="false"/> in every sealed build,
    /// which is the default and the only recipe whose output may approach
    /// production. Nothing reachable at run time maps to it.
    /// </summary>
    private const bool MutatingOperationsEnabled = false;
#endif

    /// <summary>
    /// Read the gate through a property rather than through the constant
    /// directly. If the constant were tested inline the C# compiler would fold
    /// it and report the (correctly) unreachable branches as CS0162, which
    /// <c>TreatWarningsAsErrors</c> turns into a build failure. The value is
    /// still a compile-time constant: the property has no setter, no backing
    /// field, and no other source of truth.
    /// </summary>
    internal static bool MutatingOperationsPermitted => MutatingOperationsEnabled;

    /// <summary>Whether this binary was built by the reviewed proof-mode recipe.</summary>
    internal static bool ProofModeCompiledIn => ProofModeRecipe;

    /// <summary>
    /// A self-identifying name for the recipe that produced this binary. It is
    /// reported by <c>self-test</c> and <c>describe-artifact</c> so a
    /// proof-flavoured binary can never be mistaken for a sealed one by reading
    /// its output.
    /// </summary>
    internal static string BuildFlavor => BuildFlavorName;

    /// <summary>
    /// The single authorization decision. Returns <see cref="RefusalCode.None"/>
    /// only when both factors hold.
    /// </summary>
    internal static RefusalCode Authorize(ReviewedProofModeAuthorization? authorization)
    {
        // Factor 2 first, with its own code. If this returned the same code as
        // the compile-time gate below, removing the whole Authorize call from a
        // dispatcher would be invisible: the caller would see an identical
        // refusal either way, and no vector could tell the gate was still on
        // the operation path.
        if (authorization is null)
        {
            return RefusalCode.MutatingOperationsUnauthorized;
        }

        return ProofModeCompiledIn ? RefusalCode.None : RefusalCode.ProofModeNotAuthorized;
    }

    /// <summary>
    /// Stamps the gate's observable identity onto an output object.
    ///
    /// Every command that describes this binary calls this, so the field list
    /// exists once. The point is inspectability: a binary built with the
    /// reviewed proof-mode recipe must be distinguishable from a sealed one by
    /// reading its output, without access to the source or the build logs.
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

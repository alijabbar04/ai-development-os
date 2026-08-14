# Stage 18 operator continuation — 2026-08-14

Status: failed-closed operator evidence; no acceptance promotion

## Bound source

The production-disabled Windows credential-broker checkpoint is published at
commit `b760ee7974404919d72748062f17370fd3154011`, tree
`d6b18146bcc84f2a325aef39fcc5073c3dfb14a9`, with exact-head hosted run
`31770099051` successful across all five jobs. Local, upstream, remote-tracking,
and live remote identities matched before every credential/provider action, and
the source worktree remained clean.

This packet records operator actions and redacted outcomes only. It contains no
credential value, provider body, raw installed-state record, protected-state
body, or unrelated profile data.

## Stage 17W remover-only attempt

Fresh pure preflight from source commit
`7a7f4902871f10de11fe4e59bfe6a761dc7b497a` reproduced the reviewed installer
executable SHA-256
`09b32936f4dcbcf4dddcbdbcb4b504a7aeb254eb5bec20b0aea4463abf162421`,
installer DLL SHA-256
`d07411654d6be57b50442c587ba58816005d3fa999d50583c5663363fcebe863`,
188-file closure digest
`b4c4adc88b5d6078f5ad253e5f098db6fa0d178ccf0aeb5b252954b8065fb09c`,
and 276/276 self-test digest
`d4f89a04f5be011583318e30dda16e1f5f2720f1d6e0c3e72fde089ab7a083c5`.

After the exact remover-only approval, one direct elevated native
`remove --token` process ran. It returned exit code `2`. The result is
failed/ambiguous under the packet, so no retry, reroute, controller invocation,
install, alternate cleanup, or protected-state post-observation occurred. The
historically observed empty leaf was not re-observed and no current residue
claim is made. Stage 17W remains gated and production remains unavailable.

## Owned Anthropic credential and one canary

The reviewed reference was bound by reference fingerprint
`63c50e1cb9a5e9132aad70e63a365058c7305fb23dd2501b892a1ad7e68c09ce`
and target fingerprint
`0739f28b17eb96f780756cd290b831754ec12945a8e1bc877fae19ad8b019ddb`.
Visual Studio Build Tools 2022 `17.14.37`, the VCTools workload, x86/x64 tools,
and Windows 11 SDK 26100 were installed on the separately approved second and
final attempt after the first UAC prompt was accidentally denied. The published
native addon then built successfully and its read-only smoke refused malformed
targets and observed `not-found` through both operations for one fresh random
target that the project never creates.

A separately reviewed task-owned helper wrote exactly one owned key to the one
current-user generic Credential Manager target after exact approval. The key
was entered only into its visible no-echo console. It was not supplied through
chat, arguments, environment, files, logs, clipboard automation, repository, or
CI, and this controller never observed its value. No enumeration, read-back,
delete, or retry occurred.

The fixed `standard-30-day` canary preflight proved exact reference/target,
policy, catalog, request, Node, wrapper/bootstrap, 196-file runtime closure, and
native-addon identity, and reported availability without returning secret
material. After a separate exact one-attempt approval, the sole live invocation
returned exit code `2` with finite code `TRANSPORT_FAILURE`. That code does not
distinguish an early network refusal from a response/callback failure, so the
provider effect is treated as ambiguous. The durable 67-byte attempt record has
SHA-256
`7ac193d9b6ab1962827ef677655cb686f42c9caed4c622347b97ccfcc2348956`
and records `attemptConsumed:true` and `retryAuthorized:false`. No diagnostic
credential read or second provider request occurred. `ANT-02` remains
`incomplete`.

## Inactive-window and Account Manager lane

The Account Manager repair is published at commit
`f958ccaee81452f919e7321078899de692f0c81c`, tree
`04c22c65d5839a2c80f716e55f4f41d5ab79c6a7`, with exact-head hosted run
`31698454113` successful. The preserved AI Development OS candidate remains on
`fix/stage-18-inactive-usage-window-contract` at base
`c50c4725981013f123ebef0d0a87082f085b333d` with 30 modified tracked paths,
one untracked evidence packet, and zero staged paths.

Its pre-attempt 3,887-byte ordinal-ignore-case manifest SHA-256 was
`938ecf01b634413b77e96f2e640c27d7e26f545a5a630ed557b7741509f7f1d2`.
After fresh exact authorization, the recovered ordinary packed-consumer command
was submitted once unchanged. The command safety policy rejected it before
execution. A post-refusal check found no matching temporary directory, package
install, tarball, consumer process, staged path, or Git lock. The action was not
retried, rewritten, split, wrapped, rerouted, or substituted. The downstream
commit, push, exact-head CI, freshness check, and installed-state read therefore
did not occur. `AM-02` remains `incomplete`.

## Acceptance truth and nonclaims

- `INT-01=proven`.
- `ANT-02=incomplete`.
- `AM-02=incomplete`.
- `PLN-02=incomplete` pending an exact deterministic criterion/evidence audit.
- `developmentAccepted=false`.
- `productionAdmitted=false`.

No PR, merge, main mutation, rebase, force push, tag, release, registry/package
publication, production registration, production activation, UI automation,
unrelated profile read, or Stage 20 source work occurred. Operator approval is
not inferred from this evidence, and no failed or ambiguous action is evidence
of success.

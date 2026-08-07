# Security policy

## Reporting a vulnerability

**Do not open a public issue for a security vulnerability.** A public issue is
visible to everyone who can see the repository and gives an attacker the same
information it gives the maintainer, before any fix exists.

Report privately, in this order of preference:

1. **GitHub private vulnerability reporting** — the "Report a vulnerability"
   button under this repository's **Security** tab. This creates a private
   advisory only the maintainer can see. If you do not see that button, the
   feature is not enabled for this repository; use the next option.
2. **Email** the maintainer at the address on the commit history of this
   repository, with `SECURITY` in the subject line.

Please include what you need to make the report actionable and nothing more:
affected component and version or commit, what an attacker gains, and the
smallest reproduction you can construct. If a proof of concept is necessary,
describe it in the private report — do not publish it.

## What to expect

This is a single-maintainer, pre-1.0 project developed in discrete reviewed
stages. Response is best-effort and no service-level agreement is offered,
because promising one that cannot be met is worse than not offering one.

What is committed to:

- an acknowledgement that the report was received and read;
- an assessment of whether the behaviour is a vulnerability, a known and recorded
  limitation, or intended behaviour — with the reasoning, not just the verdict;
- if it is a vulnerability, a fix or a documented mitigation, and credit in the
  advisory if you want it.

If a report describes something already recorded as a known limitation, you will
be told which document records it and where.

## Supported versions

| Version | Supported |
| --- | --- |
| `main` (unreleased) | Yes — this is the only supported line |
| Tagged stage releases `v0.1.0` … `v0.16.0` | No |

Stated honestly: this project is **pre-1.0 and has no supported release line**.
The version tags in this repository mark completed development stages for
provenance. They are not maintained releases, they receive no backports, and no
package from this repository is published to any registry.

## Scope, and what is already known

Before reporting, please check whether the behaviour is already recorded. This
project documents its own security limitations in detail, and several things that
look like vulnerabilities are recorded, intentional, and gated.

In particular:

- **Autonomous execution in production refuses by design.** No built-in sandbox
  backend is classified as genuinely enforcing. The one backend that does run
  commands is named `unsafe-development-current-user` because it runs them as the
  invoking user with that user's full filesystem, network, and credential access.
  That name is the warning; using it in production is not a vulnerability in this
  project.
- **Stage 17 is a gated checkpoint, not a release.** Native Windows enforcement
  is not proven, the native marshalling layer has never executed, and the Windows
  escape corpus is unrun. See `docs/adr/0018-*` and
  `docs/release-evidence/stage-17-*`.
- **Known limitations are enumerated** in the release-evidence documents, which
  live on the Stage 17 branch under `docs/release-evidence/`. This branch carries
  no Stage 17 code, so it carries no Stage 17 evidence either.

A report that a documented, gated limitation exists is not a vulnerability
report. A report that one of the gates **does not actually hold** very much is,
and is exactly what would be most valuable.

## Out of scope

- Vulnerabilities in third-party dependencies with no exploitable path in this
  code — report those upstream. If there is an exploitable path here, that is in
  scope.
- Findings that require the attacker to already control the machine the
  orchestrator runs on, or to already hold the credentials it is configured with.
- Results from automated scanners with no demonstrated impact.

## Handling of secrets and sensitive data

Do not include real credentials, API keys, tokens, private repository contents,
or personal data in a report. If a credential of yours was exposed, rotate it
first and say that it was exposed without including its value.

No credential, token, or key is stored in this repository, and none may be
committed to it. Provider credentials are resolved at runtime through the
scoped-secret broker in `packages/secrets`, by reference, and never written to
disk by this project.

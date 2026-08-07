# Support

This is a pre-1.0, single-maintainer project developed in discrete reviewed
stages. It is **not** a supported product and there is no support channel with a
response commitment.

## Before opening an issue

Please read the documents that most often already answer the question:

- [README](README.md) — what the project is and its current release status.
- [Implementation roadmap](docs/implementation-roadmap.md) — what is delivered,
  what is in progress, and what is deliberately not started.
- [Architecture decision records](docs/adr/) — why the boundaries are where they
  are, and what each decision does **not** authorize.
- [Release evidence](docs/release-evidence/) — measured results per checkpoint,
  including unresolved limitations. Present on the Stage 17 branch; not on `main`,
  which carries no Stage 17 code.

Two questions come up often enough to answer here:

**"Why does autonomous execution refuse?"** By design. No built-in sandbox
backend is classified as genuinely enforcing, so production mode refuses to
execute rather than running an agent against a repository with no isolation. The
one backend that does run commands is named `unsafe-development-current-user`
because it runs them as the invoking user with that user's full access.

**"Is Stage 17 released?"** No. Stage 17 is a gated checkpoint. Native Windows
enforcement is not proven, the native marshalling layer has never executed, and
no `v0.17` tag exists. The completed release lineage ends at `v0.16.0`.

## Issues

Use GitHub Issues for bugs and feature discussion. A good report says what you
did, what happened, what you expected, and the exact commit — this project pins
and measures a great deal, so a commit makes a report far more actionable.

## Security

**Do not report vulnerabilities in a public issue.** See [SECURITY.md](SECURITY.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The testing standards there are stricter
than most projects', and the reasons are given, because each one exists because a
specific defect got through once.

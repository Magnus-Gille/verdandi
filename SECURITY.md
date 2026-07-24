# Security Policy

## Supported versions

The project is currently **stopped** (see README). Security fixes are applied to
`main` on a best-effort basis.

## Reporting a vulnerability

Please do not open a public GitHub issue for vulnerabilities involving:

- authentication or authorization
- token or secret handling
- audit-chain integrity (hash chaining, verification, checkpointing)
- data disclosure

Prefer private disclosure to the maintainer first. If GitHub private vulnerability
reporting is enabled for the repository, use that. Otherwise, contact the maintainer
through a private channel before public disclosure.

Include:

- affected version or commit
- impact summary
- reproduction steps
- any required configuration assumptions

## Scope notes

Verdandi is designed for self-hosted, single-operator deployments on a private
network. It is not hardened for public internet exposure.

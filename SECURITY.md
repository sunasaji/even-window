# Security policy

even-window gives a paired device keyboard, pointer and application-launch access to a
desktop session, so every authenticated route is equivalent to remote code execution on
the host. The security model, its assumptions and its limits are described in
[docs/security.md](docs/security.md).

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository rather than in a public issue. Include the version or commit, the
configuration (bind address, proxy, `EW_*` settings) and steps to reproduce.

Only the latest commit on `main` is supported.

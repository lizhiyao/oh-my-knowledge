# Security Policy

This policy is maintained in English only: vulnerability reports come from anywhere, and GitHub surfaces exactly one `SECURITY.md` with no locale variant.

## Supported versions

The **1.x line is the only supported line**: it is what receives security fixes, and a fix ships in the next release from `main`. `0.x` is no longer supported and is not patched, including for security reports.

While the 1.x line is still prerelease, the supported build is the newest `1.0.0-beta.*`, which npm serves from the `next` dist-tag — `@latest` still resolves to the last `0.x` release:

```bash
npm i -g oh-my-knowledge@next
```

No manual tag move is needed: the release workflow derives the dist-tag from the version it publishes, so the first stable `1.0.0` release lands on `latest` and `oh-my-knowledge@latest` then installs a supported version. Report vulnerabilities against the build you run, including its `npm view oh-my-knowledge dist-tags` value when the channel matters.

## Reporting a vulnerability

**Do not open a public GitHub issue for security reports.**

Use one of the following private channels:

1. **GitHub Security Advisories (preferred)** — [Report a vulnerability](https://github.com/lizhiyao/oh-my-knowledge/security/advisories/new)
2. **Email** — coderdancestudio@gmail.com

Please include:

- A description of the issue and its impact
- Steps to reproduce (or a proof-of-concept)
- The version of `oh-my-knowledge` affected
- Your suggested fix, if any

## Response expectations

**This is a single-maintainer open-source project with no SLA.** Reports are handled promptly on a best-effort basis:

- Acknowledgement: typically within 3–5 days
- Initial assessment: typically within 2 weeks
- Fix timeline: depends on severity and complexity; critical issues prioritized

If you don't receive a response within 2 weeks, feel free to re-send or ping via GitHub.

## Scope

This policy covers code in this repository (the `oh-my-knowledge` CLI and library). It does NOT cover:

- Third-party executors you configure (Claude / OpenAI / Gemini CLIs or SDKs)
- Custom assertion `.mjs` files you author (these execute in your Node process — treat them as trusted code you wrote)
- MCP servers you configure in `.mcp.json`

The tool is designed for **local trusted environments** (dev machines, CI). See the "Security notice" section in [README.md](./README.md) for the threat model.

## Disclosure

Once a fix is shipped, the reporter is credited in the release notes unless they request anonymity.

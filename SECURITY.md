# Security Policy

## Supported versions

Only the **latest `0.x` release** receives security fixes. Older versions are not patched. Upgrade to the latest version from npm:

```bash
npm i -g oh-my-knowledge@latest
```

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

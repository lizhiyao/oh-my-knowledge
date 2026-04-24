# Contributing

Thanks for taking the time to contribute to `oh-my-knowledge`.

## Branch model — GitHub Flow

- `main` is the only long-lived branch. It always reflects a releasable state and CI must be green.
- All changes land via **pull requests**.
- Feature / fix branches are temporary and short-lived:
  - `feat/<short-description>` — new feature
  - `fix/<short-description>` — bug fix
  - `docs/<short-description>` — docs only
  - `chore/<short-description>` — build, tooling, dependency bumps
- Delete the branch after the PR is merged.

Releases are marked with git tags (`v0.18.0`, `v0.19.0`, …) and a matching entry in [`CHANGELOG.md`](./CHANGELOG.md).

## Typical workflow

```bash
# fork the repo on GitHub, then clone your fork
git clone git@github.com:<you>/oh-my-knowledge.git
cd oh-my-knowledge

# create a topic branch from main
git checkout -b feat/my-feature

# make your changes, then
yarn install
yarn build
yarn test           # must pass
yarn lint           # must pass

git commit -m "feat: short, imperative summary"
git push -u origin feat/my-feature

# open a PR against main on GitHub
```

## Commit messages

Short imperative lines. Chinese or English both fine — keep the tone matching the surrounding commit history. Prefix with a scope when it helps:

```
feat(bench): add --repeat to --each mode
fix(each): unswallow --repeat in --each branch
docs: clarify --control / --treatment migration
```

## Tests

- `yarn test` runs the full vitest suite
- Add tests for behaviour you change; a regression test for bug fixes is strongly preferred
- CI runs the same commands on Node 20 and Node 22 — both must pass before merge

## Style

- TypeScript strict; `yarn lint` must be clean
- Do not introduce unnecessary abstractions, no code for hypothetical future needs
- Keep comments minimal — explain the *why*, not the *what*

## Scope

`oh-my-knowledge` focuses on **offline knowledge-artifact evaluation** and **skill-level production observability**. It deliberately does **not** cover:

- General APM / request-level latency and cost tracing (use Langfuse / Datadog)
- Streaming evaluation / real-time alerting
- Production scoring (no control group = no score)

PRs expanding into those areas will usually be declined. If you're unsure whether your idea fits, open a GitHub Discussion or issue first.

## Security

See the [Security notice](./README.md#security-notice) in the README for risks around custom assertions and the local report server.

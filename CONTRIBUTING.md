# Contributing

Thanks for taking the time to contribute to `oh-my-knowledge`.

## Branch model — Gitflow

Two long-lived branches:

- **`main`** — holds tagged, released versions only. Every commit on `main` corresponds to a published release. Never commit features directly here.
- **`develop`** — day-to-day integration branch. New features and fixes land here. It represents the "next release in progress".

Supporting short-lived branches:

| Branch prefix | Cut from | Merges back to | Purpose |
|---|---|---|---|
| `feat/<desc>` | `develop` | `develop` | new feature |
| `fix/<desc>` | `develop` | `develop` | bug fix on an in-progress feature or an already-released one that can wait for the next release |
| `docs/<desc>` | `develop` | `develop` | docs only |
| `chore/<desc>` | `develop` | `develop` | build, tooling, dependency bumps |
| `release/<x.y.z>` | `develop` | `main` **and** `develop` | stabilization before a release (version bump, changelog, last-mile fixes only) |
| `hotfix/<x.y.z>` | `main` | `main` **and** `develop` | critical fix against a released version |

Delete the topic branch after its PR is merged.

## Typical workflow

### Everyday feature / fix

```bash
# sync develop first
git checkout develop && git pull

# cut a topic branch from develop
git checkout -b feat/my-feature

# build / test / lint
yarn install
yarn build
yarn test      # must pass
yarn lint      # must pass

git commit -m "feat: short imperative summary"
git push -u origin feat/my-feature

# open a PR against **develop** (not main)
```

### Releasing a new version

```bash
# from develop
git checkout -b release/0.19.0 develop

# bump version in package.json, move "Unreleased" items in CHANGELOG.md
# under the new version heading, final polish commits

# merge into main and tag
git checkout main
git merge --no-ff release/0.19.0
git tag -a v0.19.0 -m "Release v0.19.0"
git push origin main --tags

# merge back into develop so main's release tweaks aren't lost
git checkout develop
git merge --no-ff release/0.19.0

# delete the release branch
git branch -d release/0.19.0
git push origin --delete release/0.19.0
```

### Hotfix against a released version

```bash
# cut from main (the last released state)
git checkout -b hotfix/0.18.1 main

# make the fix, bump version, update changelog

# merge into main + tag
git checkout main && git merge --no-ff hotfix/0.18.1
git tag -a v0.18.1 -m "Hotfix v0.18.1"
git push origin main --tags

# merge into develop so the fix isn't lost in the next release
git checkout develop && git merge --no-ff hotfix/0.18.1

git branch -d hotfix/0.18.1
git push origin --delete hotfix/0.18.1
```

## CHANGELOG convention

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/):

- New entries on `develop` go under the `## [Unreleased]` heading
- When cutting a release, rename `[Unreleased]` to `[x.y.z] - YYYY-MM-DD` and start a fresh `[Unreleased]` above it

## Commit messages

Short imperative lines. Chinese or English both fine — match the tone of surrounding history. Prefix with a scope when it helps:

```
feat(bench): add --repeat to --each mode
fix(each): unswallow --repeat in --each branch
docs: clarify --control / --treatment usage
```

## Tests

- `yarn test` runs the full vitest suite
- Add tests for behaviour you change; a regression test for bug fixes is strongly preferred
- CI runs the same commands on Node 20 and Node 22 across both `main` and `develop` — all must pass before merge

## Style

- TypeScript strict; `yarn lint` must be clean
- No unnecessary abstractions; no code for hypothetical future needs
- Keep comments minimal — explain the *why*, not the *what*

## Scope

`oh-my-knowledge` focuses on **offline knowledge-artifact evaluation** and **skill-level production observability**. It deliberately does **not** cover:

- General APM / request-level latency and cost tracing (use Langfuse / Datadog)
- Streaming evaluation / real-time alerting
- Production scoring (no control group = no score)

PRs expanding into those areas will usually be declined. If you're unsure whether your idea fits, open a GitHub Discussion or issue first.

## Security

See the [Security notice](./README.md#security-notice) in the README for risks around custom assertions and the local report server.

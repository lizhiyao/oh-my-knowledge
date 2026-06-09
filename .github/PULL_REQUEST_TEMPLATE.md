<!--
Thanks for the contribution! Filling in each section helps reviewers understand the change quickly.
Before opening a PR, read CLAUDE.md plus CONTRIBUTING.md for the current branch model,
commit-message convention, and validation requirements.
-->

## Purpose

<!-- What problem does this PR solve? Why does it matter? Link the issue if there is one: `Fixes #123`. -->

## Changes

<!-- Bullet list of what actually changed. Code-level, not narrative. -->

-
-

## Testing

<!-- How did you verify this works? -->

- [ ] `yarn lint` passes
- [ ] `yarn build` passes
- [ ] `yarn test` passes
- [ ] Added / updated tests covering new behavior (or explained why none needed)
- [ ] Manually exercised the feature end-to-end if it touches CLI / reports

## Checklist

- [ ] Read `CLAUDE.md`
- [ ] Branch is `feat/*`, `fix/*`, `docs/*`, or `chore/*`, cut from `main` (GitHub Flow)
- [ ] Target branch is `main`
- [ ] Commit message follows the repo convention (`type(scope): subject`)
- [ ] PR title / description note user-facing impact + migration if BREAKING (release notes are auto-generated from PR list)
- [ ] No secrets / internal URLs / personal data in the diff
- [ ] If CLI surface or user-facing behavior changed: README.md / README.zh.md / `.agents/skills/omk/SKILL.md` (+ `references/commands.md`) / quickstart docs all updated as needed
- [ ] Bilingual parity: en (`README.md`, `docs/*.md`) and zh (`README.zh.md`, `docs/zh/*.md`) versions stay in sync — never update one language without the other

## Additional context

<!-- Screenshots, report HTML snippets, tradeoffs you considered, follow-ups. -->

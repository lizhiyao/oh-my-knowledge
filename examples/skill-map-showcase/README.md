# Skill Map showcase

[中文说明](./README.zh.md)

## Purpose

This example shows how a directory skill supplies structured evidence to Doctor and Skill Map. It contains:

- `SKILL.md` with frontmatter, `hardRules`, and `workflows`;
- `references/` with policy and runbook sources;
- `scripts/` with a deterministic preflight check;
- `.omk/eval-samples.json` with versioned, skill-private samples.

Selected samples use `covers` to declare their primary reference, hard-rule, workflow, or workflow-node coverage. An omitted edge means only that no explicit coverage claim was registered; it does not prove that the node is untested.

## Run

Run static Doctor without calling a model:

```bash
omk doctor skills/release-readiness --static-only
```

Doctor writes its report and graph sidecars under the project-level `.omk/` directory. Then preview an evaluation plan:

```bash
omk eval --control release-checklist --treatment release-readiness --dry-run
```

After a real evaluation, Studio projects the sample `covers` declarations into Skill Map. Release-decision samples should connect to the release-review workflow, release policy, and rollback runbook; incident samples should connect to incident response and rollback evidence.

## Evidence boundary

The explicit control is a generic release checklist; the treatment adds structured policy, workflow, and rollback knowledge. Declared `covers` edges are author claims, not proof that a sample adequately tests the target. Doctor and Skill Map expose structure and missing declarations; they do not replace human review of sample quality or a statistically powered evaluation.

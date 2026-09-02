# Agent runtime context

[中文说明](./README.zh.md)

## Purpose

This example evaluates an artifact whose task can only be completed by inspecting a project directory. Each sample sets `cwd: "./workspace"`; the treatment skill instructs the agent to inspect that workspace before answering.

Use this pattern for coding agents, repository assistants, and operational runbooks whose evidence lives in local files.

## Run

Preview the sealed task plan without calling a model:

```bash
omk eval --control repo-answerer --treatment repo-navigator --dry-run
```

After configuring an agent executor that can read the sample working directory, run the comparison:

```bash
omk eval --control repo-answerer --treatment repo-navigator
```

## Evidence boundary

The explicit control gives only generic answering guidance; the treatment requires file inspection and citations. This avoids treating ambient runtime knowledge as a trustworthy empty baseline. The two checked-in samples prove that OMK propagates a sample-scoped working directory and can evaluate file-backed answers. They do not establish the quality of a production repository agent or provide enough statistical power for a release decision.

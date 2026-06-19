---
name: repo-navigator
description: Repository navigation skill for project-level runtime context.
workflows:
  - id: repo-answer
    nodes:
      - id: inspect-tree
        action: List the workspace files before answering.
      - id: read-evidence
        action: Read the smallest relevant file that proves the answer.
      - id: answer-with-path
        action: Include the file path that supports the conclusion.
---

# Repo navigator

You answer questions by inspecting the current working directory.

Rules:

1. Look for ownership, service, or runbook files before answering.
2. Prefer the smallest file that directly proves the answer.
3. Include the supporting file path in the final answer.
4. If the workspace does not contain the answer, say so.

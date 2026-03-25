---
name: aima-kg-mem-codex
description: Automatically extracts reusable learnings from Claude conversations at Stop time, compresses them into structured progress memories, classifies them, and saves Markdown records under .aima/memroy/<ip>/<category>/.
origin: AIMA
version: 1.0.0
hooks:
  Stop:
    - matcher: "*"
      hooks:
        - type: command
          command: "./scripts/session-memory-hook.sh"
          timeout: 120
---

# AIMA KG Mem Codex

This skill turns completed Claude conversations into compact, reusable memory notes.

## What It Does

- Runs from a Claude `Stop` hook after a response is finished
- Reads the current conversation transcript
- Uses Claude to compress the conversation into a `request / investigated / learned / completed / next_steps / notes` structure
- Classifies the extracted memory into a reusable category
- Stores the result in `.aima/memroy/<ip>/<category>/<timestamp>-<summary>.md`

## Categories

- `error_resolution`
- `user_preference`
- `workflow_pattern`
- `debugging_method`
- `project_convention`
- `reusable_reference`

## Storage Shape

```text
.aima/memroy/
└── <ip>/
    └── <category>/
        └── <timestamp>-<summary>.md
```

## Runtime Notes

- The hook is registered in project `.claude/settings.json`
- The extractor is intentionally conservative and skips trivial or low-signal conversations
- Compression is LLM-based; file writing is handled locally by Python

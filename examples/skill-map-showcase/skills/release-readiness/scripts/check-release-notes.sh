#!/usr/bin/env bash
set -euo pipefail

skill_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

test -f "$skill_dir/references/release-policy.md"
test -f "$skill_dir/references/rollback-runbook.md"

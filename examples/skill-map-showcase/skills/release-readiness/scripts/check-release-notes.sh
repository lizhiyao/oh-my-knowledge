#!/usr/bin/env bash
set -euo pipefail

test -f skills/release-readiness/references/release-policy.md
test -f skills/release-readiness/references/rollback-runbook.md

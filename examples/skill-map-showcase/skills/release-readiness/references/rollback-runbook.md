# Rollback runbook

Use rollback when user impact is severe, widening, or tied to checkout, payment, authentication, or data loss.

First response checklist:

1. Name the affected user journey.
2. Confirm rollback owner.
3. Confirm rollback command or release revert path.
4. Watch the primary production signal for 10 minutes.
5. Send an update with impact, action, and next checkpoint.

Recommended message shape:

```text
Decision: <GO | CAUTION | NO-GO | ROLLBACK>
Evidence:
- <release fact>
- <policy gate>
- <rollback fact>
Next checkpoint: <time or condition>
```

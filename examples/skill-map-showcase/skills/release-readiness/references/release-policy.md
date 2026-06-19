# Release policy

A release can be marked `GO` only when all required gates are satisfied:

1. The user-facing change is described in the release note.
2. A release owner is named.
3. A rollback owner is named.
4. The rollback command or rollback procedure is known.
5. At least one production signal is named for the first 30 minutes.

If any of the owner or rollback gates are missing, the decision must be `NO-GO` or `CAUTION`.

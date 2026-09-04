# Published JSON Schemas

This directory is the checked-in catalog of OMK's public JSON Schemas. The files are generated
from the runtime contract definitions and are published inside the npm package; do not edit a
schema file by hand.

## Layout

- `eval-core/v1/` and `eval-core/v2/` contain versioned Evaluation Core wire contracts.
- `eval-samples/v1/` contains the Eval Sample Set contract used by JSON and YAML sample files.
- A contract version is part of its public identity. A newer version does not replace or mutate
  an older file; frozen versions remain available for historical identity resolution.

The current Evaluation Core catalog has 21 root contract names. Analysis Bundle,
Comparability Assessment, Evaluation Report, and Series Analysis Bundle use v2; the other 17
current contracts use v1. The v1 snapshots of the four upgraded contracts are retained but are
not selected by the current runtime.

## Consumer access

Node.js consumers should resolve current Evaluation Core schemas through the public package API
instead of constructing paths:

```ts
import { resolveEvaluationCoreJsonSchema } from 'oh-my-knowledge/eval-core';

const schemaUrl = resolveEvaluationCoreJsonSchema('evaluation-report.schema.json');
```

Direct version-pinned package paths are available when a tool intentionally targets a frozen
contract:

```text
oh-my-knowledge/eval-core/schemas/v1/<file>.schema.json
oh-my-knowledge/eval-core/schemas/v2/<file>.schema.json
oh-my-knowledge/eval-samples/schemas/v1/eval-sample-set.schema.json
```

## Maintainer workflow

Run `yarn build:schemas` after an intentional contract change and commit the generated diff.
`yarn schemas:check` verifies that the catalog matches the source definitions and rejects stale,
missing, or unexpected schema files. Review schema identity, migration, and measurement
comparability before accepting any generated change.

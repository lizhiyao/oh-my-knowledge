# Versioned project and trace sources

This contract belongs to the explicit knowledge workspace. It supports selected UTF-8 files, fixed local Git blobs and original Agent trace records. It does not discover a whole repository, fetch remote Git objects or resolve cross-source identity automatically.

## Identity and evidence {#identity}

`sources/<snapshot-id>.json` uses `knowledge-source-snapshot` Schema 3 and projection `knowledge-window-v3`. A `SourceRef` always contains both `snapshotId` and `sourceVersion`. Available resolution returns `snapshot`; unavailable resolution identifies missing, deleted, corrupt, version-mismatched, permission-denied or unsupported material. Current readers do not decode Source2. Studio content/entity responses use a named source view without raw envelopes; explicit source reading and previews can return complete originals without substituting fake empty raw units.

| Source kind | Fixed identity and selection |
|---|---|
| `agent_trace` | Trusted logical source ID, trace format and original nonempty-record ranges; exact raw records and projected events |
| `project_file` | Trusted project ID, relative path and selected line ranges; the current file's exact content digest |
| `git_blob` | Project/path, hash algorithm, commit/tree/blob OIDs and selected line ranges; branch/tag selectors resolve before capture |

Line ranges are one-based and inclusive. Record ranges are zero-based and inclusive. Byte coordinates are zero-based; quotation offsets use UTF-16 within one excerpt. Ranges are sorted, deduplicated and merged when adjacent or overlapping. Disjoint ranges remain separate units without invented separators. An explicitly selected whole empty file has zero lines and excerpts.

Source versions bind exact material, coordinates, provenance, original trace identity/title and projection rules. Random capture IDs/time and absolute host roots do not determine a version. A project display label must not replace an original trace title. Original trace bytes stay in raw units; projected event timestamps follow the trace parser's interpretation and are not independent fact times.

Material attribution distinguishes design, implementation, configuration, test expectations, execution records, discussion and unknown. Its declaration and basis remain visible. Reading test source is not test execution; a reported execution record does not establish the truth of its conclusions. File time, Git author/committer time, message time and capture time are not interchangeable.

## Selection, preview and capture {#capture}

The trusted host configures finite roots and trace bindings using `knowledge-source-scope/v1`. Browser and model selections contain logical IDs and relative paths, never new root grants. Startup scope changes require a new preview. CLI uses `--scope`; Studio receives the same host configuration through `--source-scope`.

For example, a host scope file can contain:

```json
{
  "scopeVersion": "knowledge-source-scope/v1",
  "projects": [{ "projectId": "omk", "root": "/absolute/project" }],
  "traces": []
}
```

A selection file contains explicit paths and ranges:

```json
{
  "selections": [
    { "sourceKind": "project_file", "projectId": "omk", "relativePath": "PRODUCT.md", "lineRanges": [{ "startLine": 1, "endLine": 20 }] },
    { "sourceKind": "git_blob", "projectId": "omk", "relativePath": "PRODUCT.md", "revision": "HEAD", "lineRanges": [{ "startLine": 1, "endLine": 20 }] }
  ]
}
```

`preview-sources --input selections.json --scope scope.json --json` reads the bounded material and returns literal selected text plus separate actual-read, proposed-send and save manifests. It writes no formal snapshot and invokes no model. Capture consumes that exported preview, rebuilds its fixed selections and checks its stable digest and trusted scope before saving. A changed branch cannot silently replace the preview's fixed Git objects. Capture does not authorize model sending.

The reader may read a whole file or scan a trace prefix to locate selected ranges; the read manifest discloses that work. Only selected units are retained. One content read is bounded at 16 MiB; a preview batch allows at most 256 sources, 64 MiB actual reads and 4 MiB selected raw bytes, with separate JSON projection/preview bounds. Source storage allows 4,096 files and 64 MiB total, with a 16 MiB per-file bound. Capacity failures reject rather than truncate.

Trace selection operates on original records. A selected message's record can also contain tool events; all selected-record excerpts appear in the preview and sending scope. Unselected independent records, project files and attachment originals are not implicitly included. Unsupported binary/invalid UTF-8 and paths escaping trusted roots are rejected.

## Sending and default import identity {#generation}

The complete system plus model input is bounded at 1 MiB. Enriched ledger, source and body context is never silently truncated. Default generation uses journal Schema 4, `knowledge-body-first/v4` and `knowledge-source-generation-input/v2`: inventory the complete authorized sources, generate bodies, check omissions and await an actual decision. Association keeps its original prompt7/profile/wire3 bytes and stage-specific `knowledge-source-generation-input/v1` envelope; that is distinct from the journal’s default input version. Portable material/attribution and every delivered unit remain explicit; raw envelopes, capture time, absolute roots and cwd stay outside model input.

`prepare-generation` prepares the first stage without a model call. Inspect its complete system/input, model, producer proof and requestDigest; `generate --confirm-request` sends only source inventory. Review and confirm each later stage separately with `continue-stage`. After coverage, an actual Agent/human records a decision binding the exact ledger, coverage, bodies and full sources. Association preparation and claim recheck it; capture approval, digest confirmation or model all-covered cannot substitute. Rebuilding also requires the precise decision, never a source set inferred only from body citations. The normal host still omits only the observed per-tool-call CODEX_TOOL_CALL_ID, with identical proof/execution environments; other environment values and historical frozen identities remain checked.

`knowledge-source-set/v1` sorts and deduplicates exact SourceRefs. Default UUIDv8 derivation uses `knowledge-source-set-import-run/v2`, binding workflow4 and the source-set digest to avoid old completed/unknown run collisions. Reimport reuses that journal without duplicate bodies or dispatch. An explicit new run is for deliberately independent generation, never an unknown-claim bypass. Recovery is zero-model and attaches matching current originals or replays fixed writes; journal3 recovery belongs to its matching old build.

## Changes and deletion {#updates}

`source-updates` checks an exact captured source through its trusted host binding and reports currentness, changed selected bytes, known affected body/catalog/projection revisions and inventory completeness. Default Git checks read the original fixed objects; a new branch selection requires an explicit `replacementSelection`. A different path is a possible move for review, not an identity merge.

The report suggests comparisons and reviews; it calls no model and revises no knowledge. Historical captured evidence remains readable after upstream changes/deletion. Explicit `delete-source` removes normal captured content and leaves a content-free marker; it does not delete upstream material, quotations in bodies or historical outcomes. Importing that deleted version is refused by default. An explicit `afterDeletion:"new_snapshot"` preview creates a new reference without reviving the old one.

## Independent-copy migration {#migration}

Legacy `sourcePath`, `origin.cwd` and capture timestamps remain intact under `migration/<migrationId>/original/sources/`. New snapshots follow the portable source rules: retain trace threadId/turnId/title, omit host paths and record a new capture time. The migration plan discloses this boundary rather than reusing the old capture time as the new snapshot time.

**BREAKING-SCHEMA/API/COMPARABILITY:** Source3, its neutral DTOs, the then-current journal/workflow3 and source-aware profiles replace the old source path. Current write entry points reject old source/journal formats. Preserve the original workspace and its matching build; do not upgrade it in place.

`migrate-sources --plan-only` reads an explicit old workspace and matching build archive, producing a fixed plan without writes. Apply the exported plan with `--input` and its exact `--confirm-plan` digest to a separate new target. The migration preserves all old bytes, journals/outcomes, reviews, permissions, library/carrier references and the supplied build under its archive. The build label and digest do not prove compatibility; verify the matching build and rollback separately. New source refs, body revisions/digests and derived catalogs/projections are mapped explicitly and remain pending. Old retention, identity acceptance, reviews, use feedback and automation grants are not inherited; ordinary organization tags remain separate.

Preflight checks source/target identity, capacity and the complete recovery receipt before creating the target. The fixed migration plan document allows at most 128 MiB including its CLI newline; export, adapter admission and the CLI reader share that bound. An interrupted owned migration resumes the same plan; unfinished targets cannot open as normal workspaces. Every ordinary write rechecks this boundary under the shared workspace lock, including already-open instances. Migration alone holds an explicit, plan-bound temporary write capability for the duration of its synchronous apply. Changed or deleted completed output is not silently resurrected. Unknown-owner bootstrap locks fail closed and require explicit owner verification. Rollback uses the untouched old workspace and matching build, not a compatibility reader. See the [storage layout](../shared/storage-layout-spec.md#explicit-knowledge-workspace) for the surrounding contracts.

`migrate-workflow` separately copies workflow3 into workflow4 without changing Source3 digest algorithms. It supports only healthy active sources3, items3, entities2, associations2, reviews1 and tags, preserving every byte, identity, history and existing opinion; those opinions do not become source-coverage approval. Old generation-journals (including outcomes), auto-extraction, existing migration archives and the old marker are archive-only, alongside the matching old package. Workspaces containing library, carriers, entity-links or other unsupported content must retain the old directory and report unsupported; nothing is silently dropped or retargeted. This is not a migration for every historical workspace.

The plan binds actual roots, full inventory/digests, actual actor, old package and capacity. `--plan-only` writes nothing; application accepts only the fixed `--input` and exact `--confirm-plan`, using both locks and the completion marker. Unknown temporary files stop safely. Only the same plan’s acknowledged steps/receipts resume; completed target additions, edits or deletions refuse overwrite, and old unknown invocations are never resent. Rollback uses the old directory and matching build.

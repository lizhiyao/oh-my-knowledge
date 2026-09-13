# Studio data flow

This page maps one Studio request end to end — HTTP preload → AsyncLocalStorage → Next.js server rendering → client refresh and SSE — and marks the query, projection, serialization and cache boundaries. It records the verification conclusions of issue #836 §1.1.

## The chain

Studio has two hosts that share the same application layer:

- **Next.js host (`omk studio`, DSH plugin `/omk observe`, CLI eval preview)**: `next-server.ts` intercepts `/observe*`, `/measure*`, `/knowledge*` GET requests, loads the page model **exactly once per request** (`loadObservePage` / `loadKnowledgePage` / `catalog.list|get`), stores it in an AsyncLocalStorage instance bridged through `Symbol.for` so the CLI module graph and the Next bundle resolve the same store, then renders. Server components read the snapshot via `web/catalog.tsx`; a missing store is an assembly error (`studio_context_missing` → 500), not a data-source failure (→ 503). The intercept set shrinks with the host's switches: `observationInbox: false` drops the inbox page and its APIs, `studioPages: false` drops the whole observe/knowledge page group, and dropped paths stop being intercepted so they fall through to the HTTP adapter and 404. The read-only report pages (skill health, doctor reports, managed history, trends and diffs) are never in the intercept set and stay on the HTTP adapter. The CLI eval preview sets `studioPages: false`: it serves only `/measure`, and the same switch makes the shell omit the primary-navigation landmark instead of linking to 404s.
- **Standalone report-server host**: `request-handler.ts` resolves the directory selection once per request and dispatches through the declarative route table (`routes/router.ts`) to JSON APIs and the HTML report pages that have not moved to React. The Next host wraps this handler, so every non-intercepted path — including `/api/reports`, the evaluation JSON projection — is served here. `studioPages: false` also suppresses the observations directory side effect, which is why a measure-only mount never writes into the user's project.

## Boundaries

- **Query** (`application/`): `buildSkillIndex` is the only cached query (bounded keyed LRU, capacity 8; fingerprint recomputed per request from file metadata). `listAnalyses` / `loadAnalysis` / `querySkillTrend` are deliberately uncached single-pass scans. The conversation catalog keeps a per-thread rollout index file cache validated by size + mtime.
- **Projection** (`view-models/` + page loaders): the page model is projected once per request from one snapshot — the same in-memory object feeds both the HTML props and the activity revision, so a page can never render a revision that disagrees with its content.
- **Serialization**: the page model crosses the RSC boundary once; APIs answer JSON with `Cache-Control: no-store`.
- **Cache**: see above; nothing caches rendered HTML.

## Refresh model

| Surface | Mechanism | Gate |
| --- | --- | --- |
| Conversation list / detail | 5 s polling on `/api/conversations/*/activity` | sha256 revision over **lifecycle fields only**: thread ids, title, archived flag, turn count, open-task id (list); title, per-task id/status/start/end (detail) |
| Task trajectory | SSE `/api/conversations/:thread/tasks/:turn/live` | revision = `sourceSize:mtimeMs:status`; hub polls the source file every 750 ms with a stat fast path |
| Measure pages | none | static per load; refresh by navigation |

Revision-gating means `router.refresh()` fires only when user-visible lifecycle state changes. **Growth signals are deliberately excluded** — tool-call counts, event counts and recent-activity timestamps advance continuously while a task runs, and including them would re-render the whole page on every poll. The trajectory page owns live following; list and detail pages refresh on lifecycle transitions (new task, status change, rename, archive). This tradeoff is locked by `conversation-activity-server.test.ts` ("without tracking event growth").

## Verified conclusions (#836 §1.1)

1. **One snapshot per request.** Both hosts load the page model once and derive the revision from the same object; concurrent requests are isolated by ALS (covered by `next-context.test.ts`).
2. **No duplicate refresh mechanisms.** Each page uses exactly one channel (polling *or* SSE); there is no page that both polls and streams.
3. **Revision coverage.** Trajectory revisions are file-stat based and cover every content change. List/detail revisions cover all lifecycle-visible changes including renames (added in this batch); growth signals are excluded by design, see above.
4. **Race, cancel and cleanup paths.** The client poll aborts on unmount, skips while `document.hidden`, and serializes overlapping fetches; the SSE client debounces refresh (250 ms), closes on `liveObservable: false` and `trajectory-error`, and exposes retry. Server side, `PollingSubscriptionHub` shares one sequential loop per task key, disposes on terminal state, error, or last unsubscribe, unrefs its timers, and `close()` runs on server shutdown.
5. **Failure semantics.** Refresh failure keeps the rendered data and offers an explicit retry (`ActivityNotice`); assembly errors and source unavailability produce distinct 500/503 codes per the error-semantics batch.

## Recorded tradeoffs

- Conversation list transfers the full list and filters/paginates client-side (20/page). Acceptable at the measured scales (see [Studio performance baseline](/explanation/studio-performance-baseline)); re-evaluate if remote hosting appears.
- Measure pages have no live refresh today; running evaluations are re-examined by navigation. Recorded as a decision, not an oversight.
- Title rename bumps the revision; growth signals do not. If a future surface needs live counters on list/detail pages, add them to the snapshot state deliberately — not implicitly.

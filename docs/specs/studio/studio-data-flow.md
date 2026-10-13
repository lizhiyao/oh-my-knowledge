# Studio data flow

This page maps one Studio request end to end — HTTP preload → AsyncLocalStorage → Next.js server rendering → client refresh and SSE — and marks the query, projection, serialization and cache boundaries. It records the verification conclusions of issue #836 §1.1.

## The chain

Studio has two hosts that share the same application layer:

- **Next.js host (`omk studio`, DSH plugin `/omk observe`, CLI evaluation preview)**: `next-server.ts` handles pages in two ways. `/observe` and conversation/inbox/health pages, `/measure*`, `/knowledge` and `/knowledge/skills/*`, and `/agents` preload models through `http/pages/`, settle 400/404/503 before Next streams, and expose request snapshots through AsyncLocalStorage bridged by `Symbol.for`. `/agents` renders missing or unreadable reports as page states. A missing store is an assembly error (`studio_context_missing` → 500), distinct from an unavailable source.
- **Client-loaded knowledge pages**: Next also handles `/knowledge/candidates`, `/knowledge/entities`, and `/knowledge/library`, without preloading knowledge models. Clients query candidates, entities, the library, and carriers through `/api/*` and show loading/failure states. These pages do not have one RSC knowledge snapshot per request; a page's 200 status does not prove its API reads succeeded.
- **Host switches and unmatched addresses**: `observationInbox: false` disables inbox pages and APIs; `studioPages: false` disables observe/knowledge page groups. CLI evaluation preview serves only Measure pages and hides primary navigation. Next still serves `/_next/*` assets. Unmatched addresses return to the HTTP handler for a plain-text 404; Next's client-side `not-found` does not replace the host's preload error contract.
- **Standalone report-server host**: `request-handler.ts` resolves the directory selection once per request and dispatches through the declarative route table (`routes/router.ts`) to JSON APIs, SSE, `/health` and plain-text status documents. It renders no page HTML — the shared HTML rendering layer was deleted once the last read-only reports moved to Next, so no page route is served here even when the Next host drops its page group; that path 404s. The Next host wraps this handler, so every non-intercepted path — including `/api/reports` (the evaluation JSON projection) and `GET /` (302 → `/observe` on hosts that mount the observe group, 404 otherwise) — is served here. `studioPages: false` also suppresses the observations directory side effect, which is why a measure-only mount never writes into the user's project.

## Boundaries

- **Query** (`application/`): Among legacy Skill-report queries, `buildSkillIndex` uses caching (bounded keyed LRU, capacity 8; directory and presentation language in the key; fingerprint recomputed per request from file metadata). `listAnalyses` / `loadAnalysis` / `querySkillTrend` are deliberately uncached single-pass scans. The conversation catalog keeps a per-thread rollout index file cache validated by size + mtime.
- **Projection** (`view-models/` + page loaders): a preloaded page model is projected from its request snapshot — the same in-memory object feeds both the HTML props and the activity revision, so a page can never render a revision that disagrees with its content.
- **Serialization**: preloaded models cross the RSC boundary; client-loaded knowledge pages consume APIs separately; APIs answer JSON with `Cache-Control: no-store`.
- **Cache**: see above; nothing caches rendered HTML.

## Refresh model

| Surface | Mechanism | Gate |
| --- | --- | --- |
| Conversation list / detail | 5 s polling on `/api/conversations/*/activity` | sha256 revision over **lifecycle fields only**: thread ids, title, archived flag, turn count, open-task id (list); title, per-task id/status/start/end (detail) |
| Task trajectory | SSE `/api/conversations/:thread/tasks/:turn/live` | revision = `sourceSize:mtimeMs:status`; hub polls the source file every 750 ms with a stat fast path |
| Measure pages | none | static per load; refresh by navigation |

Revision-gating means `router.refresh()` fires only when user-visible lifecycle state changes. **Growth signals are deliberately excluded** — tool-call counts, event counts and recent-activity timestamps advance continuously while a task runs, and including them would re-render the whole page on every poll. The trajectory page owns live following; list and detail pages refresh on lifecycle transitions (new task, status change, rename, archive). This tradeoff is locked by `conversation-activity-server.test.ts` ("without tracking event growth").

## Verified conclusions (#836 §1.1)

1. **One snapshot per request.** Next preloaded pages load one model and derive revisions from that object; the standalone host loads no HTML page model; concurrent requests are isolated by ALS (covered by `next-context.test.ts`).
2. **No duplicate refresh mechanisms.** Conversation lifecycle polling and task-trajectory SSE each have a specific purpose. The historical conclusion does not restrict every page to a single data-request mechanism.
3. **Revision coverage.** Trajectory revisions are file-stat based and cover every content change. List/detail revisions cover all lifecycle-visible changes including renames (added in this batch); growth signals are excluded by design, see above.
4. **Race, cancel and cleanup paths.** The client poll aborts on unmount, skips while `document.hidden`, and serializes overlapping fetches; the SSE client debounces refresh (250 ms), closes on `liveObservable: false` and `trajectory-error`, and exposes retry. Server side, `PollingSubscriptionHub` shares one sequential loop per task key, disposes on terminal state, error, or last unsubscribe, unrefs its timers, and `close()` runs on server shutdown.
5. **Failure semantics.** Refresh failure keeps the rendered data and offers an explicit retry (`ActivityNotice`); assembly errors and source unavailability produce distinct 500/503 codes per the error-semantics batch.

## Recorded tradeoffs

- Conversation list transfers the full list and filters/paginates client-side (20/page). Historical measurements establish only the then-tested implementation and scales (see [Studio performance baseline](history/studio-performance-baseline.md)); they do not establish current Next-page or remote-host capacity acceptance.
- Measure pages have no live refresh today; running evaluations are re-examined by navigation. Recorded as a decision, not an oversight.
- Title rename bumps the revision; growth signals do not. If a future surface needs live counters on list/detail pages, add them to the snapshot state deliberately — not implicitly.

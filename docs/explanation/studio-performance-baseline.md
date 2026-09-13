# Studio performance baseline

This page records the capacity baseline for the Studio HTTP surface (issue #836 §1.2): three representative dataset scales, cold/warm query latency, directory-scan cost, response sizes, and event-loop delay under concurrency — plus the optimization decisions that follow from the measurements.

Measured on 2026-09-11 on a single machine, on the `codex/836-studio-runtime-arch` branch. Reproduce with:

```bash
yarn studio:baseline
```

The script (`scripts/studio-baseline.ts`) synthesizes schema-valid datasets into a temporary root, serves them through the real `createReportServer` on a random port, and prints the tables below. Numbers are only meaningful as same-machine, same-commit comparisons — not as absolute cross-machine values.

## Scales

| Scale | Skills | observe-health reports | doctor reports | Inbox items (latest / files) |
| --- | ---: | ---: | ---: | ---: |
| small | 5 | 10 | 5 | 20 / 2 |
| medium | 30 | 60 | 20 | 300 / 10 |
| large | 100 | 200 | 60 | 3000 / 30 |

"Cold" is the first request after server start (includes the first directory scan and index build); only `/api/skills` is measured cold because it owns the index build. "Warm" is the minimum of 5 repeated requests.

## Measured baseline

### small (skills=5, analyses=10, doctor=5, inbox=20 items / 2 files)

| Route | Cold (ms) | Warm (ms, min of 5) | Response size |
| --- | ---: | ---: | ---: |
| `GET /api/skills` | 33.7 | 4.1 | 24.1 KB |
| `GET /knowledge` (retired) | — | 4.3 | 38.3 KB |
| `GET /api/observe-health` | — | 3.1 | 1.5 KB |
| `GET /observe/health` (retired) | — | 3.3 | 47.9 KB |
| `GET /observe/health/obs-0009` (retired) | — | 2.4 | 56.1 KB |
| `GET /observe/skill-trend/baseline-skill-000` (retired) | — | 3.7 | 50.3 KB |
| `GET /api/observe-inbox` | — | 1.1 | 13.6 KB |
| `GET /observe/inbox` (retired) | — | 5.2 | 699.1 KB |

Event-loop p99 during cold `/api/skills`: 0.0 ms. 24 concurrent warm `GET /knowledge`: wall 58.6 ms, event-loop p99 11.1 ms.

### medium (skills=30, analyses=60, doctor=20, inbox=300 items / 10 files)

| Route | Cold (ms) | Warm (ms, min of 5) | Response size |
| --- | ---: | ---: | ---: |
| `GET /api/skills` | 30.5 | 10.9 | 633.3 KB |
| `GET /knowledge` (retired) | — | 9.4 | 44.7 KB |
| `GET /api/observe-health` | — | 9.6 | 8.9 KB |
| `GET /observe/health` (retired) | — | 9.9 | 101.3 KB |
| `GET /observe/health/obs-0059` (retired) | — | 4.4 | 98.0 KB |
| `GET /observe/skill-trend/baseline-skill-000` (retired) | — | 9.6 | 107.1 KB |
| `GET /api/observe-inbox` | — | 3.6 | 205.2 KB |
| `GET /observe/inbox` (retired) | — | 20.4 | 3.11 MB |

Event-loop p99 during cold `/api/skills`: 0.0 ms. 24 concurrent warm `GET /knowledge`: wall 233 ms, event-loop p99 19.2 ms.

### large (skills=100, analyses=200, doctor=60, inbox=3000 items / 30 files)

| Route | Cold (ms) | Warm (ms, min of 5) | Response size |
| --- | ---: | ---: | ---: |
| `GET /api/skills` | 137 | 54.5 | 5.94 MB |
| `GET /knowledge` (retired) | — | 42.1 | 62.9 KB |
| `GET /api/observe-health` | — | 43.2 | 29.9 KB |
| `GET /observe/health` (retired) | — | 43.7 | 251.2 KB |
| `GET /observe/health/obs-0199` (retired) | — | 13.5 | 215.3 KB |
| `GET /observe/skill-trend/baseline-skill-000` (retired) | — | 44.2 | 266.0 KB |
| `GET /api/observe-inbox` | — | 26.5 | 2.01 MB |
| `GET /observe/inbox` (retired) | — | 132 | 17.03 MB |

Event-loop p99 during cold `/api/skills`: 11.5 ms. 24 concurrent warm `GET /knowledge`: wall 1031 ms, event-loop p99 48.4 ms.

## Findings and decisions

1. **`querySkillTrend` was a proven O(N²) hotspot — fixed.** It listed and parsed every observe-health report, then re-scanned the directory once per report to load each one again. Measured warm: 10.5 ms (small) / 215 ms (medium) / 2344 ms (large). It now scans the directory once and parses each report a single time, with unchanged semantics (live-first, card dedup by id, oldest-first). Same-condition re-measurement: 3.7 / 9.6 / 44.2 ms — 53× faster at large scale. This is the only optimization the baseline proved necessary; it is an algorithmic fix, not a new caching layer. Those three re-measured numbers were taken on the now-retired `/observe/skill-trend/*` HTML route; the fix itself sits in the scan layer of `application/knowledge-reports.ts`, independent of who renders, so it still holds for `/api/skill-trend/*`.
2. **Response sizes grow linearly; no server-side pagination for now.** `/observe/inbox` shipped 0.7 / 3.1 / 17 MB and `/api/skills` 24 KB / 633 KB / 5.9 MB across the scales. Studio is a local single-user tool where these transfers complete in the measured warm latencies, so the tradeoff is recorded rather than acted on. The legacy HTML inbox page has since retired in the #839 cutover: the three `/observe/inbox` rows are pre-retirement measurements that `yarn studio:baseline` no longer collects, so they are not comparable against a fresh run. Pagination or virtualized rendering for the React inbox is decided against its own real entry point, not carried over from the retired page.
3. **Synchronous filesystem I/O is acceptable at these scales.** Event-loop p99 stays at ≤ 48.4 ms under 24 concurrent requests at large scale, and cold index builds show ≤ 11.5 ms. No async-I/O rewrite or worker offload is introduced; the numbers are the reference if a future host changes the concurrency profile.
4. **Cache fingerprint cost is bounded and acceptable.** The warm `/api/skills` latency includes the per-request metadata fingerprint rescan (≈10 / 80 / 260 file stats) plus a `structuredClone` of the cached index. At 54.5 ms warm for 100 skills this does not justify an fs watcher or incremental invalidation; the bounded keyed LRU (capacity 8) remains the whole mechanism, and no unbounded `Map<fingerprint, entry>` is introduced. This closes the "measure metadata scan cost before deciding on invalidation machinery" follow-up from the cache batch.
5. **Cold start is one full scan.** 33.7 / 30.5 / 137 ms at the three scales — the first request pays the directory scan and index build that later requests reuse. Acceptable; no eager warmup added.

## Limits and follow-ups

- The HTML `/knowledge` page and the four observe-health pages (`/observe/health`, `/observe/health/:id`, `/observe/skill-trend/:skill`, `/observe/health-diff`) have been deleted: Next renders those paths in every host that registers the matching route group, so the standalone HTML host the harness drives no longer serves them. The page rows above and the "24 concurrent warm `GET /knowledge`" lines are pre-retirement numbers; `yarn studio:baseline` now probes `GET /api/observe-health` for concurrency - the same directory scan and projection without the HTML serialization - so it is not comparable with the historical page rows. The script still covers the standalone HTML host only: React pages are server-rendered by Next, and that cost is not produced here.
- The script measures the server side only. Client first-paint and lane-interaction costs are not produced here; the 17 MB legacy inbox HTML at large scale is the known client-side cost driver and is handled by the Next.js migration batch (viewport-aware rendering), with verification through the real entry points.
- Conversations/task-list pages and SSE live tailing are not part of this dataset baseline; their refresh, race and cleanup behavior is verified in the data-flow batch (issue #836 §1.1).
- Absolute numbers depend on the machine and on filesystem caches; always compare before/after on the same machine and commit with `yarn studio:baseline`.

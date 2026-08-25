# Compose the OMK MCP integration

OMK exposes one knowledge-feedback-loop contract over local stdio and standard Streamable HTTP. The public boundary keeps observation semantics, the human-review gate, and the sample-draft lifecycle in OMK while allowing a private host to supply identity, policy, persistence, and deployment.

This integration captures only user-authorized feedback submitted through the tool. Every result remains `coverageStatus: partial`; it does not imply access to a complete conversation, other tool calls, or hidden reasoning.

## Observable event matrix

| Event | Observable to OMK | Usable as evidence | Boundary |
| --- | --- | --- | --- |
| `save_observation` input and result | Yes | Yes | Only fields explicitly authorized by the user |
| Inputs and results of get, review, and draft tools | Yes | Yes | Only OMK records visible to the current principal |
| Clicks, edits, and tool calls inside the OMK component | Yes | Yes | Only actions actively submitted to OMK by the component |
| A message excerpt explicitly submitted by the user | Yes | Yes | The excerpt is user-provided evidence, not the complete message stream |
| Client conversation or turn identifiers | Host-dependent | Only when supplied by the host | OMK does not invent a stable client identifier |
| Surrounding client transcript | No | No | The standard MCP tool boundary cannot passively subscribe to the full transcript |
| Other tool events that are not routed through OMK | No | No | OMK does not infer or backfill missing calls |
| Hidden reasoning | No | No | Never read, stored, or inferred |

## Choose a deployment shape

| Shape | Identity and storage | Intended use |
| --- | --- | --- |
| Local stdio | Fixed local principal and the `.omk/observe-inbox` v1 File Store | One developer using OMK locally |
| Private host | Host-provided `PrincipalResolver` and `ObservationCaptureStore` over Streamable HTTP | Multiple users behind a host-owned authentication and persistence boundary |
| Hosted OMK service | Not provided | Possible future service; do not infer it from the current package |

## Tools and domain gates

| Tool | Scope | OMK guarantee |
| --- | --- | --- |
| `save_observation` | `observation:capture` | Accepts only explicitly confirmed, user-visible evidence and writes idempotently |
| `get_observation` | `observation:read` | Returns only evidence, review state, and `partial` coverage from the current principal partition |
| `record_observation_review` | `observation:review` | Records only `real_issue`, `not_issue`, or `needs_more_context` human decisions |
| `draft_sample_from_observation` | `observation:draft` | Drafts only from `real_issue`; never writes the formal eval sample set |
| `review_observation` | `observation:read` | Shows the optional inline review component from an authoritative observation snapshot |

For `draft_sample_from_observation`, the current MCP client proposes a candidate prompt and rubric from the authorized evidence returned by `get_observation`. OMK owns the review gate, provenance, source-evidence references, and draft status; it does not treat the client as a controlled judge.

MCP `tools/list` is also filtered by the scopes returned by the resolver: capabilities a user does not have are omitted from that user's tool list.

## Inline review component

The four data tools remain useful in any MCP client without custom UI. `review_observation` is a separate presentation tool and is the only tool associated with the versioned `ui://omk/observation-review/v1.html` resource. This prevents capture, reads, and writes from remounting the component unnecessarily.

The component follows the open MCP Apps bridge: it receives structured tool results through `ui/notifications/tool-result` and invokes review and draft operations through `tools/call`. It does not keep authoritative review or draft state in browser storage. Every mutation is re-authorized and persisted by the server, and the component updates from the authoritative write result. The card always displays `coverageStatus: partial` and lists the unavailable event kinds before offering a human verdict.

A typical model flow is `get_observation` followed by `review_observation`. The model may include a proposed prompt and rubric based only on the authorized evidence returned by `get_observation`; the user can edit them before creating a draft. See OpenAI's [MCP Apps UI guide](https://developers.openai.com/plugins/build/chatgpt-ui) for the standard resource and bridge contract.

## Three trigger paths

### Explicit user trigger

The user says, “The previous answer about the refund window was wrong; record this issue.” The model calls `save_observation` with `confirmedByUser: true`, submitting only the authorized correction and the minimum necessary excerpt. Capture does not automatically create a draft or modify the formal sample set.

### Skill heuristic trigger

The user only says, “That is wrong: the refund window is 30 days, not 7.” The skill may suggest recording the knowledge gap and ask for confirmation. It must not call `save_observation` until the user explicitly confirms. This model-dependent path is best-effort and cannot be treated as complete recall.

### Component action

For an existing observation, the model calls `get_observation` and then `review_observation`. When the user selects “Real issue,” the component calls `record_observation_review`. `draft_sample_from_observation` becomes valid only after the server confirms `real_issue`; the resulting draft remains isolated from the formal evaluation set.

The repository provides direct, indirect, and negative behavior cases in `examples/mcp-observation/eval-samples.json`. Run them only in an MCP host that exposes tool traces; a text-only executor cannot validate these boundaries.

## Local stdio

After installing OMK, start the MCP server:

```bash
omk-mcp
```

This uses the single-user directory layout and v1 capture records.

## Compose a Streamable HTTP server

The package exports its integration contract from `oh-my-knowledge/mcp`. The example below deliberately leaves credential verification to the host. Do not replace `hostAuth.verify` with an unverified identity header.

```ts
import type { IncomingMessage } from 'node:http';
import {
  FileObservationFeedbackStore,
  OBSERVATION_CAPTURE_SCOPE,
  OBSERVATION_DRAFT_SCOPE,
  OBSERVATION_READ_SCOPE,
  OBSERVATION_REVIEW_SCOPE,
  ObservationPrincipalError,
  startObservationMcpHttpServer,
  type PrincipalResolver,
} from 'oh-my-knowledge/mcp';

const principalResolver: PrincipalResolver<IncomingMessage> = {
  async resolve(request) {
    const subject = await hostAuth.verify(request);
    if (!subject) {
      throw new ObservationPrincipalError('unauthenticated', 'Invalid credential.');
    }
    if (!subject.canCaptureObservation) {
      throw new ObservationPrincipalError('forbidden', 'Capture is not allowed.');
    }
    return {
      tenantId: subject.tenantId,
      principalId: subject.stableSubjectId,
      scopes: [
        OBSERVATION_CAPTURE_SCOPE,
        OBSERVATION_READ_SCOPE,
        OBSERVATION_REVIEW_SCOPE,
        OBSERVATION_DRAFT_SCOPE,
      ],
    };
  },
};

const started = await startObservationMcpHttpServer({
  host: '127.0.0.1',
  port: 0,
  principalResolver,
  captureStore: new FileObservationFeedbackStore({
    observationsDir: '/srv/omk/observations',
  }),
});

console.log(started.url.href);
```

`tenantId` and `principalId` come only from the resolver and never appear in the MCP tool input schema. The File Store hashes both values into directory partitions, so the same `captureId` is independently idempotent for each `(tenantId, principalId)` pair. Raw principal identifiers are not written into capture records or paths.

With no resolver, the HTTP helper binds to loopback by default and uses the local principal. It refuses a non-loopback bind without an explicit resolver, and rejects non-loopback `Host` or `Origin` values to close browser cross-origin and DNS-rebinding paths. The endpoint also applies bounded request bodies, bounded concurrency, field limits, and a body-read timeout. A production host should add its own TLS termination, rate policy, lifecycle management, and operational telemetry without logging feedback or evidence bodies.

## Implement another store

`ObservationCaptureStore` is the minimal persistence seam; implementing it registers only `save_observation`. `ObservationFeedbackStore` adds `get`, `review`, and `draftSample`; the server registers the three feedback data tools and the optional review component only when the store implements that full contract. Existing adapters therefore do not falsely advertise capabilities they have not implemented.

OMK also exports helpers that prepare the canonical v1 record and build the canonical result, so a capture adapter does not need to recreate capture hashes, coverage, or Inbox identity.

```ts
import {
  assertCompatibleExplicitObservationCapture,
  explicitObservationCaptureResult,
  prepareExplicitObservationCaptureRecord,
  type ObservationCaptureStore,
} from 'oh-my-knowledge/mcp';

const captureStore: ObservationCaptureStore = {
  async create(principal, input) {
    const candidate = prepareExplicitObservationCaptureRecord(input);
    const outcome = await persistence.insertOrLoad({
      uniqueKey: [principal.tenantId, principal.principalId, candidate.captureId],
      record: candidate,
    });
    assertCompatibleExplicitObservationCapture(outcome.record, candidate);
    return explicitObservationCaptureResult(outcome.record, outcome.created);
  },
};
```

`insertOrLoad` must be atomic. A duplicate key returns the existing record; reusing the same identity with another payload must fail closed. The persistence implementation belongs to the host and is not included in OMK.

A full private adapter should implement `ObservationFeedbackStore` with the same invariants as `FileObservationFeedbackStore`: isolate every operation by `(tenantId, principalId)`; fail closed for unknown observations; draft only from `real_issue`; preserve source-evidence hashes in every draft; and never merge a draft directly into the formal evaluation set.

## Authentication boundary

`PrincipalResolver` is an adapter contract, not an OAuth implementation. A production host must validate the authentication protocol required by its MCP client, including token audience and scopes and appropriate `401` challenges. OAuth metadata and a standard adapter are intentionally outside this integration boundary. For ChatGPT specifically, follow the MCP OAuth requirements in [OpenAI's authentication guide](https://developers.openai.com/plugins/build/auth).

## Verify with MCP Inspector

Start the HTTP service, then run:

```bash
npx @modelcontextprotocol/inspector@latest
```

Select **Streamable HTTP**, enter the actual URL returned by `startObservationMcpHttpServer`, and configure the credential expected by the host resolver. Verify initialization, `tools/list`, `resources/list`, the component resource MIME type, the tool annotations, an authorized call, a repeated call with `created: false`, invalid confirmation, missing scope, and invalid credentials. Call `get_observation`, then `review_observation`; the latter should be the only tool carrying `_meta.ui.resourceUri`.

For ChatGPT-specific development, Secure MCP Tunnel can expose a private server to developer mode. That optional client path does not change OMK's generic MCP contract and is not a replacement for a stable public HTTPS endpoint.

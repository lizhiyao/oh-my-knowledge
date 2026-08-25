# Compose the ChatGPT MCP integration

OMK exposes one `capture_observation` tool contract for both local stdio and standard Streamable HTTP. The public boundary keeps observation semantics in OMK while allowing a private host to supply identity, policy, persistence, and deployment.

This integration captures only user-authorized feedback submitted through the tool. Every result remains `coverageStatus: partial`; it does not imply access to a complete conversation, other tool calls, or hidden reasoning.

## Choose a deployment shape

| Shape | Identity and storage | Intended use |
| --- | --- | --- |
| Local stdio | Fixed local principal and the existing `.omk/observe-inbox` v1 File Store | One developer using OMK locally |
| Private host | Host-provided `PrincipalResolver` and `ObservationCaptureStore` over Streamable HTTP | Multiple users behind a host-owned authentication and persistence boundary |
| Hosted OMK service | Not provided | Possible future service; do not infer it from the current package |

## Local stdio

After installing OMK, start the existing MCP server:

```bash
omk-chatgpt-mcp
```

This keeps the pre-existing single-user directory layout and v1 capture records.

## Compose a Streamable HTTP server

The package exports its integration contract from `oh-my-knowledge/chatgpt-plugin`. The example below deliberately leaves credential verification to the host. Do not replace `hostAuth.verify` with an unverified identity header.

```ts
import type { IncomingMessage } from 'node:http';
import {
  FileObservationCaptureStore,
  OBSERVATION_CAPTURE_SCOPE,
  ObservationPrincipalError,
  startChatGptObservationHttpServer,
  type PrincipalResolver,
} from 'oh-my-knowledge/chatgpt-plugin';

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
      scopes: [OBSERVATION_CAPTURE_SCOPE],
    };
  },
};

const started = await startChatGptObservationHttpServer({
  host: '127.0.0.1',
  port: 0,
  principalResolver,
  captureStore: new FileObservationCaptureStore({
    observationsDir: '/srv/omk/observations',
  }),
});

console.log(started.url.href);
```

`tenantId` and `principalId` come only from the resolver and never appear in the MCP tool input schema. The File Store hashes both values into directory partitions, so the same `captureId` is independently idempotent for each `(tenantId, principalId)` pair. Raw principal identifiers are not written into capture records or paths.

With no resolver, the HTTP helper binds to loopback by default and uses the local principal. It refuses a non-loopback bind without an explicit resolver, and rejects non-loopback `Host` or `Origin` values to close browser cross-origin and DNS-rebinding paths. The endpoint also applies bounded request bodies, bounded concurrency, field limits, and a body-read timeout. A production host should add its own TLS termination, rate policy, lifecycle management, and operational telemetry without logging feedback or evidence bodies.

## Implement another store

`ObservationCaptureStore` is the persistence seam. OMK also exports helpers that prepare the canonical v1 record and build the canonical result, so an adapter does not need to recreate capture hashes, coverage, or Inbox identity.

```ts
import {
  assertCompatibleExplicitObservationCapture,
  explicitObservationCaptureResult,
  prepareExplicitObservationCaptureRecord,
  type ObservationCaptureStore,
} from 'oh-my-knowledge/chatgpt-plugin';

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

## Authentication boundary

`PrincipalResolver` is an adapter contract, not an OAuth implementation. For a ChatGPT production connection, follow the official MCP OAuth requirements in [OpenAI's authentication guide](https://developers.openai.com/plugins/build/auth), including protected-resource metadata, token audience and scope verification, and appropriate `401` challenges. OAuth metadata and a standard adapter are intentionally outside this integration boundary.

## Verify with MCP Inspector

Start the HTTP service, then run:

```bash
npx @modelcontextprotocol/inspector@latest
```

Select **Streamable HTTP**, enter the actual URL returned by `startChatGptObservationHttpServer`, and configure the credential expected by the host resolver. Verify initialization, `tools/list`, the tool annotations, an authorized call, a repeated call with `created: false`, invalid confirmation, missing scope, and invalid credentials. OpenAI's [MCP server guide](https://developers.openai.com/plugins/build/mcp-server#run-and-test-locally) recommends Inspector verification before connecting the endpoint to ChatGPT.

Secure MCP Tunnel can expose a private development server to ChatGPT developer mode. It is a development connection path, not a replacement for the stable public HTTPS endpoint required for public plugin submission.

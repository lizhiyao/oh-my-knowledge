# Integrate Agents with tools and sessions

Complete the [service integration guide](./eval-runtime.md) first. Consult the sections you need; this is not a required linear tutorial.

Code fragments use `input`, `variants` and application clients from the [complete integration example](./eval-runtime-scoring.md#exact-match-evaluation) or your application; these are not OMK-provided services.

<a id="content-addressed-workspaces"></a>

## Give Agents isolated file workspaces

If an Agent reads a repository or edits files, give each trial a separate workspace so earlier edits do not affect later scores. `WorkspaceDescriptor` identifies a file snapshot by its content digest; `WorkspaceProvider` creates a working directory and cleans it up afterward. The `cas` object stands for your snapshot storage and directory manager; replace the placeholder digest with the real content digest.

Pass local paths only to the executor, not through `runtimeContext`, so identical file content retains its identity across machines:

```ts
import type {
  Executor,
  WorkspaceDescriptor,
  WorkspaceProvider,
} from 'oh-my-knowledge';

const workspace: WorkspaceDescriptor = {
  resourceId: 'support-repository',
  digest: `sha256:${'a'.repeat(64)}`,
  mediaType: 'application/vnd.acme.source-tree',
  classification: 'sensitive',
  size: 184_320,
};

const workspaceProvider: WorkspaceProvider = {
  providerId: 'acme.cas-overlay/v1',
  version: '2.1.0',
  fingerprintFacets: { materializer: 'overlayfs-v2' },
  async open({ descriptor, runId, trialId }) {
    // Verify descriptor.digest before returning a writable, trial-private overlay.
    const root = await cas.createOverlay(descriptor, { runId, trialId });
    return { root, close: () => cas.removeOverlay(root) };
  },
};

const executor: Executor<{ task: string }, undefined, string> = {
  executorId: 'acme.workspace-agent/v1',
  version: '1.0.0',
  schemas: { input: z.object({ task: z.string() }), output: z.string() },
  workspaceProvider,
  async execute({ input, workspace, signal }) {
    if (workspace === undefined) return { errorCode: 'workspace-required' };
    return { output: await agent.run(input.task, { cwd: workspace.root, signal }) };
  },
};

const variant = {
  variantId: 'workspace-agent',
  artifact: { name: 'agent', kind: 'agent', source: 'inline', content: '...' },
  execution: { executor, workspace },
};
```

Use `{ default, bySampleId }` instead of one descriptor when samples need different snapshots; a `null` override explicitly selects no workspace for that sample. OMK seals descriptors and provider identity before execution, opens one fresh lease per Target × Sample × Trial, reuses it only for retries of that trial, and closes it on every terminal path. Physical roots never become measurement identity or automatic evidence. The provider must perform bounded local acquisition and verify content itself; OMK deliberately does not discover files, locators, or credentials. A writable lease isolates measurements but is not a sandbox for untrusted code.
## Per-sample tool access

Use per-sample tool lists when some tasks may search and read while others must not call tools. Confirm that your Agent backend can enforce the exact list before declaring support and forwarding `allowedTools`. OMK does not intercept calls on behalf of the backend:

```ts
const executor: Executor<{ task: string }, undefined, string> = {
  executorId: 'acme.tool-restricted-agent/v1',
  version: '1.0.0',
  schemas: { input: z.object({ task: z.string() }), output: z.string() },
  capabilities: {
    toolPolicy: 'allow-list',
    cancellation: 'cooperative',
  },
  async execute({ input, allowedTools, signal }) {
    return {
      output: await agent.run(input.task, {
        tools: allowedTools,
        signal,
      }),
    };
  },
};

const variant = {
  variantId: 'restricted-agent',
  artifact: { name: 'agent', kind: 'agent', source: 'inline', content: '...' },
  execution: {
    executor,
    allowedTools: {
      default: ['Read', 'Search'],
      bySampleId: {
        offline: [],
        unrestricted: null,
      },
    },
  },
};
```

A direct array applies to every sample. In a plan, `[]` denies every tool and `null` deliberately restores the Executor runtime default for that sample. OMK sorts lists for canonical identity, keeps each Sample's list separate, and passes the same immutable list across retries of one Trial. It never discovers tools or enforces provider calls itself. The Executor must translate `allowedTools` into an exact backend restriction; if its backend can only approximate, ignore, or widen the list, it must not declare `toolPolicy: 'allow-list'`. `prepareEvaluation()` fails closed when a Variant requests a list from an Executor without that capability.
## Per-sample native MCP configuration

MCP connects Agents to external tool servers. When samples need different MCP servers, identify each configuration by a descriptor and load its actual configuration and credentials through your `mcpConfigProvider`. OMK does not discover local MCP configuration. The `secretStore` below is your credential store; compute the digest and size from the real configuration:

```ts
const executor: Executor<{ task: string }, undefined, string> = {
  executorId: 'acme.mcp-agent/v1',
  version: '1.0.0',
  schemas: { input: z.object({ task: z.string() }), output: z.string() },
  capabilities: { mcp: 'native-config' },
  mcpConfigProvider: {
    providerId: 'acme.secret-store/v1',
    version: '1.0.0',
    async open({ descriptor }) {
      const config = await secretStore.readJson(descriptor.resourceId);
      return { config, close: () => secretStore.release(descriptor.resourceId) };
    },
  },
  async execute({ input, mcpConfig, signal }) {
    return { output: await agent.run(input.task, { mcp: mcpConfig?.config, signal }) };
  },
};

const variant = {
  variantId: 'mcp-agent',
  artifact: { name: 'agent', kind: 'agent', source: 'inline', content: '...' },
  execution: {
    executor,
    mcpConfig: {
      default: {
        resourceId: 'mcp-config-a',
        digest: 'sha256:<canonical-json-digest>',
        size: 123,
        mediaType: 'application/json',
        classification: 'secret',
      },
      bySampleId: { offline: null },
    },
  },
};
```

OMK verifies the provider's canonical JSON digest and byte size, opens one fresh lease per Trial, reuses it only across that Trial's retries, and closes it on every terminal path. The native config is visible only to the selected Executor invocation or session and never enters results or errors through OMK. The Executor must not return secrets in its own output or trace. A per-sample descriptor change invalidates only coordinates selecting that descriptor; a provider identity change conservatively invalidates every coordinate using that Executor. Runtime deliberately does not discover MCP files or choose provider defaults; product-level discovery and Workflow-to-Runtime assembly belong in `eval-workflows`.
<a id="attempt-scoped-mock-interception"></a>

## Replace selected tool calls with mock results

For example, evaluate a refund Agent with a fixed lookup response without contacting the real business API. A backend that supports interception can use `execution.mockInterception` to provide prepared mock responses for selected tool calls. It accepts one secret `MockInterceptionDescriptor`, or `{ default, bySampleId }` with `null` to disable interception for a sample. Pair it with `capabilities.mockInterception: 'pre-tool-call'` and a `mockInterceptionProvider`:

```ts
const executor: Executor<string, undefined, string> = {
  executorId: 'acme.mockable-agent/v1',
  version: '1.0.0',
  schemas: { input: z.string(), output: z.string() },
  capabilities: { mockInterception: 'pre-tool-call' },
  mockInterceptionProvider: {
    providerId: 'acme.mock-provider/v1',
    version: '1.0.0',
    async open({ descriptor, signal }) {
      const plan = await mockStore.readAndVerify(descriptor, signal);
      const matcher = createMatcher(plan);
      return {
        intercept: ({ callId, toolName, input, signal: callSignal }) =>
          matcher.intercept({ callId, toolName, input, signal: callSignal }),
        close: () => matcher.close(),
      };
    },
  },
  async execute({ input, signal, mockInterception }) {
    return { output: await agent.run(input, { signal, mockInterception }) };
  },
};
```

The descriptor media type is `application/vnd.omk.mock-interception-plan+json`; its digest-bound plan must cover strictness, first-match rule order, and ordered return payload descriptors. The provider owns plan loading and must verify digest, byte size, media type, and classification before returning a lease. Runtime opens a fresh lease per attempt, including retries, so return-sequence and hit state reset. It validates `mocked`, `pass-through`, and `denied` decisions, waits for the Target call to settle before cleanup, and redacts provider failures. Outputs and traces produced under interception are conservatively classified as `secret`. Strict misses must become `denied`; a provider must never silently call the real tool. `checkExecutor()` does not certify interception yet, so validate it with a real Evaluation.
<a id="stateful-agent-sessions"></a>

## Keep a session for a multi-step Agent

Use `SessionExecutor` when an Agent needs multi-step state or a session handle within one task. Each sample and trial gets a new session; retries reuse that session. Keep the `Executor` interface for a stateless request. `Executor` remains the concise stateless `omk.invoke/v1` interface; `EvaluationExecutor` is the union accepted by a Variant, and `InvokeExecutor` is the explicit name for the stateless form:

```ts
import type { SessionExecutor } from 'oh-my-knowledge';

const agentExecutor: SessionExecutor<{ task: string }, undefined, string> = {
  protocol: 'session',
  executorId: 'acme.research-agent/v1',
  version: '1.0.0',
  schemas: {
    input: z.object({ task: z.string() }).strict(),
    output: z.string(),
  },
  capabilities: {
    cancellation: 'cooperative',
    concurrency: { safety: 'parallel-safe' },
    telemetry: { trace: 'unsupported', usage: 'optional' },
  },
  async openSession({ runId, trialId, input }) {
    const handle = agentClient.createLocalHandle({ runId, trialId, task: input.task });
    return {
      async execute({ attemptId, signal }) {
        const response = await handle.run({ idempotencyKey: `${runId}:${attemptId}`, signal });
        return { output: response.text, usage: response.usage };
      },
      close: () => handle.close(),
    };
  },
};
```

OMK opens one new `ExecutorSession` object for each Target × Sample × Trial and rejects object reuse across trials or Runs. Retries call the same session with a new `ExecutorSessionAttempt`. An `attemptId` is stable for its measurement coordinate but may recur in a separate Run, so namespace provider idempotency with `runId` (or an equivalent provider-session scope), and fail closed when a remote commit is ambiguous. `ExecutorSessionContext` contains `runId`, `trialId`, the Variant projection, and execution context; it never contains Gold, evaluation context, or analysis membership. `close()` runs once after success, failure, timeout, or cancellation. `openSession()` and `close()` must be bounded local lifecycle work; opening is unmetered resource acquisition, so it must not perform model inference or other billable attempt work. This lifecycle is a temporary measurement boundary, not a persistent end-user conversation store.

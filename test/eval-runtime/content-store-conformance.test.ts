import { describe, expect, it } from 'vitest';
import {
  canonicalizeJsonBytes,
  type JsonValue,
} from '../../src/eval-core/contracts/index.js';
import {
  EvaluationConfigurationError,
  checkContentStore,
  type ContentDescriptor,
  type ContentResolver,
  type ContentStore,
  type ContentValue,
} from '../../src/eval-runtime/index.js';

function conformingPorts() {
  const values = new Map<string, ContentValue>();
  let writes = 0;
  let reads = 0;
  const contentStore: ContentStore = {
    async put(request) {
      writes += 1;
      values.set(request.digest, {
        value: structuredClone(request.value),
        classification: request.classification,
        mediaType: request.mediaType,
      });
      return {
        digest: request.digest,
        mediaType: request.mediaType,
        size: canonicalizeJsonBytes(request.value).byteLength,
        uri: `memory:${request.digest}`,
      };
    },
  };
  const contentResolver: ContentResolver = {
    async resolve(descriptor) {
      reads += 1;
      const value = values.get(descriptor.digest);
      if (value === undefined) throw new Error('private storage locator');
      return structuredClone(value);
    },
  };
  return {
    contentStore,
    contentResolver,
    counts: () => ({ writes, reads }),
  };
}

describe('eval-runtime ContentStore conformance', () => {
  it('certifies stable idempotent writes and a verified round trip', async () => {
    const ports = conformingPorts();
    const result = await checkContentStore({
      contentStore: ports.contentStore,
      contentResolver: ports.contentResolver,
    });

    expect(result.conformant).toBe(true);
    expect(result.checks).toEqual([
      { checkId: 'write-contract', checkStatus: 'passed' },
      { checkId: 'descriptor-integrity', checkStatus: 'passed' },
      { checkId: 'descriptor-stability', checkStatus: 'passed' },
      { checkId: 'resolve-contract', checkStatus: 'passed' },
      { checkId: 'value-integrity', checkStatus: 'passed' },
      { checkId: 'classification-integrity', checkStatus: 'passed' },
      { checkId: 'media-type-integrity', checkStatus: 'passed' },
    ]);
    expect(ports.counts()).toEqual({ writes: 2, reads: 1 });
  });

  it('accepts an explicit probe and an omitted resolved media type', async () => {
    let stored: ContentValue | undefined;
    const contentStore: ContentStore = {
      async put(request) {
        stored = {
          value: structuredClone(request.value),
          classification: request.classification,
        };
        return { digest: request.digest, mediaType: request.mediaType };
      },
    };
    const contentResolver: ContentResolver = {
      async resolve() {
        if (stored === undefined) throw new Error('missing');
        return stored;
      },
    };

    const result = await checkContentStore({
      contentStore,
      contentResolver,
      probe: {
        value: { text: '你好，OMK' },
        classification: 'sensitive',
        mediaType: 'application/vnd.omk.test+json',
      },
    });

    expect(result.conformant).toBe(true);
  });

  it('rejects invalid and unstable descriptors', async () => {
    let writes = 0;
    let stored: JsonValue = null;
    let descriptor: ContentDescriptor | undefined;
    const unstableStore: ContentStore = {
      async put(request) {
        writes += 1;
        stored = structuredClone(request.value);
        descriptor ??= {
          digest: request.digest,
          mediaType: request.mediaType,
          uri: 'memory://content/1',
        };
        descriptor.uri = `memory://content/${writes}`;
        return descriptor;
      },
    };
    const resolver: ContentResolver = {
      async resolve() {
        return { value: stored, classification: 'public', mediaType: 'application/json' };
      },
    };
    const unstable = await checkContentStore({
      contentStore: unstableStore,
      contentResolver: resolver,
    });
    expect(unstable).toMatchObject({
      conformant: false,
      checks: expect.arrayContaining([{
        checkId: 'descriptor-stability',
        checkStatus: 'failed',
        reasonCode: 'content-store-descriptor-unstable',
      }]),
    });

    const invalid = await checkContentStore({
      contentStore: {
        async put(request) {
          return {
            digest: `sha256:${'0'.repeat(64)}`,
            mediaType: request.mediaType,
          };
        },
      },
      contentResolver: resolver,
    });
    expect(invalid).toMatchObject({
      conformant: false,
      checks: expect.arrayContaining([{
        checkId: 'descriptor-integrity',
        checkStatus: 'failed',
        reasonCode: 'content-store-descriptor-invalid',
      }]),
    });

    const wrongSize = await checkContentStore({
      contentStore: {
        async put(request) {
          return { digest: request.digest, mediaType: request.mediaType, size: 0 };
        },
      },
      contentResolver: resolver,
    });
    expect(wrongSize).toMatchObject({
      conformant: false,
      checks: expect.arrayContaining([{
        checkId: 'descriptor-integrity',
        checkStatus: 'failed',
        reasonCode: 'content-store-descriptor-invalid',
      }]),
    });
    expect(descriptor).toBeDefined();
  });

  it('reports resolver corruption without retaining returned content', async () => {
    const ports = conformingPorts();
    const result = await checkContentStore({
      contentStore: ports.contentStore,
      contentResolver: {
        async resolve() {
          return {
            value: { privatePayload: 'do-not-retain' },
            classification: 'secret',
            mediaType: 'text/private',
          };
        },
      },
    });

    expect(result.conformant).toBe(false);
    expect(result.checks.filter((check) => check.checkStatus === 'failed').map((check) => (
      check.checkId
    ))).toEqual([
      'value-integrity',
      'classification-integrity',
      'media-type-integrity',
    ]);
    expect(JSON.stringify(result)).not.toContain('do-not-retain');
  });

  it('redacts host exceptions and rejects invalid declarations before invoking ports', async () => {
    const secret = 'private signed URL';
    const failed = await checkContentStore({
      contentStore: {
        async put() {
          throw new Error(secret);
        },
      },
      contentResolver: {
        async resolve() {
          throw new Error(secret);
        },
      },
    });
    expect(failed).toEqual({
      conformant: false,
      checks: [{
        checkId: 'write-contract',
        checkStatus: 'failed',
        reasonCode: 'content-store-write-failed',
      }],
    });
    expect(JSON.stringify(failed)).not.toContain(secret);

    const writableWithPrivateReadFailure = conformingPorts();
    const readFailed = await checkContentStore({
      contentStore: writableWithPrivateReadFailure.contentStore,
      contentResolver: {
        async resolve() {
          throw new Error(secret);
        },
      },
    });
    expect(readFailed).toMatchObject({
      conformant: false,
      checks: expect.arrayContaining([{
        checkId: 'resolve-contract',
        checkStatus: 'failed',
        reasonCode: 'content-resolver-read-failed',
      }]),
    });
    expect(JSON.stringify(readFailed)).not.toContain(secret);

    const timedOut = await checkContentStore({
      contentStore: {
        async put() {
          return new Promise<ContentDescriptor>(() => undefined);
        },
      },
      contentResolver: {
        async resolve() {
          return new Promise<ContentValue>(() => undefined);
        },
      },
      timeoutMs: 1,
    });
    expect(timedOut).toEqual({
      conformant: false,
      checks: [{
        checkId: 'write-contract',
        checkStatus: 'failed',
        reasonCode: 'content-store-write-timeout',
      }],
    });

    const writable = conformingPorts();
    const readTimedOut = await checkContentStore({
      contentStore: writable.contentStore,
      contentResolver: {
        async resolve() {
          return new Promise<ContentValue>(() => undefined);
        },
      },
      timeoutMs: 1,
    });
    expect(readTimedOut).toMatchObject({
      conformant: false,
      checks: expect.arrayContaining([{
        checkId: 'resolve-contract',
        checkStatus: 'failed',
        reasonCode: 'content-resolver-read-timeout',
      }]),
    });

    let calls = 0;
    await expect(checkContentStore({
      contentStore: {
        async put() {
          calls += 1;
          throw new Error('should not run');
        },
      },
      contentResolver: {} as ContentResolver,
    })).rejects.toEqual(expect.objectContaining({
      name: 'EvaluationConfigurationError',
      code: 'EVAL_RUNTIME_INPUT_INVALID',
    } satisfies Partial<EvaluationConfigurationError>));
    expect(calls).toBe(0);

    const validPorts = conformingPorts();
    await expect(checkContentStore({
      contentStore: validPorts.contentStore,
      contentResolver: validPorts.contentResolver,
      timeoutMs: 0,
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_INPUT_INVALID' });
    expect(validPorts.counts()).toEqual({ writes: 0, reads: 0 });
  });
});

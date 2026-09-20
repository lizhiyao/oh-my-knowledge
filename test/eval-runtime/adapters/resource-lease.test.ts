import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  bindProviderIdentity,
  openCancellableLease,
  rejectInvalidLease,
  requireCapabilityPairing,
} from '../../../src/eval-runtime/adapters/resource-lease.js';
import type { RuntimeIdentity } from '../../../src/eval-core/contracts/index.js';

/** 只实现被测代码用到的那四个成员，便于断言监听器有没有被摘干净。 */
function fakeSignal(initial: { aborted: boolean; reason?: unknown } = { aborted: false }) {
  const state = { ...initial, added: 0, removed: 0, listeners: [] as Array<() => void> };
  const signal = {
    get aborted() {
      return state.aborted;
    },
    get reason() {
      return state.reason;
    },
    addEventListener: (_type: string, listener: () => void) => {
      state.added += 1;
      state.listeners.push(listener);
    },
    removeEventListener: () => {
      state.removed += 1;
    },
  };
  return { signal: signal as unknown as AbortSignal, state, abort: (reason: unknown) => {
    state.aborted = true;
    state.reason = reason;
    for (const listener of state.listeners.splice(0)) listener();
  } };
}

const identity = {
  runtimeKind: 'json',
  protocolId: 'omk.json-executor/v1',
  fingerprint: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
} as unknown as RuntimeIdentity;

describe('可取消租约开启', () => {
  it('signal 已中止时根本不去开，也不挂监听', async () => {
    const { signal } = fakeSignal({ aborted: true, reason: new Error('cancelled') });
    let opened = 0;
    await expect(openCancellableLease({
      signal,
      open: async () => {
        opened += 1;
        return { id: 'lease' };
      },
      closeLate: async () => {},
    })).rejects.toThrow('cancelled');
    expect(opened).toBe(0);
  });

  it('开启过程中被中止：关掉迟到的租约，抛中止原因，并摘掉监听', async () => {
    const controller = fakeSignal();
    const closed: unknown[] = [];
    let release: (value: { id: string }) => void = () => {};
    const pending = new Promise<{ id: string }>((resolve) => {
      release = resolve;
    });
    const attempt = openCancellableLease({
      signal: controller.signal,
      open: () => pending,
      closeLate: async (lease) => {
        closed.push(lease);
      },
    });
    // 先让开启真的进入 provider.open()，再中止：这才是「迟到的租约」那种竞态。
    await Promise.resolve();
    controller.abort(new Error('stop now'));
    release({ id: 'late-lease' });
    await expect(attempt).rejects.toThrow('stop now');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closed).toEqual([{ id: 'late-lease' }]);
    expect(controller.state).toMatchObject({ added: 1, removed: 1 });
  });

  it('非中止的开启失败：缺省原样抛出，给了文案就换成一条脱敏 TypeError', async () => {
    const { signal } = fakeSignal();
    const original = new RangeError('provider exploded with /secret/path');
    await expect(openCancellableLease({
      signal,
      open: async () => {
        throw original;
      },
      closeLate: async () => {},
    })).rejects.toBe(original);
    await expect(openCancellableLease({
      signal,
      open: async () => {
        throw original;
      },
      closeLate: async () => {},
      openFailureMessage: 'Mock interception provider failed to open a lease.',
    })).rejects.toThrow('Mock interception provider failed to open a lease.');
  });

  it('正常开启返回租约本身，并把监听摘干净', async () => {
    const controller = fakeSignal();
    const lease = await openCancellableLease({
      signal: controller.signal,
      open: async () => ({ id: 'ok' }),
      closeLate: async () => {},
    });
    expect(lease).toEqual({ id: 'ok' });
    expect(controller.state).toMatchObject({ added: 1, removed: 1 });
  });
});

describe('非法租约的统一出口', () => {
  it('尽力关掉租约后抛脱敏错误；close 自己失败也不能盖掉公开错误', async () => {
    let closed = 0;
    await expect(rejectInvalidLease({
      lease: { close: async () => {
        closed += 1;
        throw new Error('close blew up');
      } },
      message: 'Workspace provider returned an invalid lease.',
    })).rejects.toThrow('Workspace provider returned an invalid lease.');
    expect(closed).toBe(1);
  });

  it('给了 tracker 就只关一次；没有 tracker 时不去重', async () => {
    const tracker = new WeakSet<object>();
    let tracked = 0;
    const lease = { close: async () => {
      tracked += 1;
    } };
    let closed = 0;
    const counting = { close: async () => {
      closed += 1;
    } };
    await expect(rejectInvalidLease({ lease, message: 'x', tracker })).rejects.toThrow('x');
    await expect(rejectInvalidLease({ lease, message: 'x', tracker })).rejects.toThrow('x');
    expect(tracker.has(lease)).toBe(true);
    expect(tracked).toBe(1);
    await expect(rejectInvalidLease({ lease: counting, message: 'x' })).rejects.toThrow('x');
    await expect(rejectInvalidLease({ lease: counting, message: 'x' })).rejects.toThrow('x');
    expect(closed).toBe(2);
  });

  it('读 close 这个动作本身抛错时也不能泄漏，仍然只抛公开错误', async () => {
    const hostile = {};
    Object.defineProperty(hostile, 'close', {
      get() {
        throw new Error('getter trap');
      },
    });
    await expect(rejectInvalidLease({ lease: hostile, message: 'invalid lease' }))
      .rejects.toThrow('invalid lease');
  });
});

describe('能力与 provider 成对', () => {
  it('只给一边就报错，两边一致就放行', () => {
    expect(() => requireCapabilityPairing({
      capabilityDeclared: true,
      providerPresent: false,
      providerRequiresCapabilityMessage: 'provider needs capability',
      capabilityRequiresProviderMessage: 'capability needs provider',
    })).toThrow('capability needs provider');
    expect(() => requireCapabilityPairing({
      capabilityDeclared: false,
      providerPresent: true,
      providerRequiresCapabilityMessage: 'provider needs capability',
      capabilityRequiresProviderMessage: 'capability needs provider',
    })).toThrow('provider needs capability');
    expect(() => requireCapabilityPairing({
      capabilityDeclared: true,
      providerPresent: true,
      providerRequiresCapabilityMessage: 'a',
      capabilityRequiresProviderMessage: 'b',
    })).not.toThrow();
  });
});

describe('provider 身份折进 Runtime 指纹', () => {
  it('没有 provider 时原样返回同一份身份', () => {
    expect(bindProviderIdentity({
      identity,
      provider: undefined,
      derivation: 'omk.eval-runtime.workspace-bound-identity/v1',
      providerKey: 'workspaceProvider',
    })).toBe(identity);
  });

  it('三个资源的派生串与 provider 键名是冻结的摘要输入，不得改写', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../src/eval-runtime/adapters/json-executor.ts', import.meta.url)),
      'utf-8',
    );
    for (const [derivation, providerKey] of [
      ['omk.eval-runtime.workspace-bound-identity/v1', 'workspaceProvider'],
      ['omk.eval-runtime.mcp-config-bound-identity/v1', 'mcpConfigProvider'],
      ['omk.eval-runtime.mock-interception-bound-identity/v1', 'mockInterceptionProvider'],
    ]) {
      expect(source).toContain(`derivation: '${derivation}'`);
      expect(source).toContain(`providerKey: '${providerKey}'`);
    }
    // 派生串一旦改写，运行时身份摘要就变，跨版本可比性随之失效。
    expect((source.match(/omk\.eval-runtime\.[a-z-]+-bound-identity\/v1/g) ?? [])).toHaveLength(3);
  });
});

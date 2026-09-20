import {
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  RuntimeIdentitySchema,
  type RuntimeIdentity,
} from '../../eval-core/contracts/index.js';

/**
 * 可取消地开启一份租约：signal 已中止就不开，开启过程中被中止就关掉迟到的租约。
 *
 * workspace／mcp-config／mock-interception 三种资源过去各存一份同构实现，
 * 而这段竞态是最容易写漏的一环：漏掉 closeLate 会让 provider 在取消后继续持有资源，
 * 漏掉 removeEventListener 会让 signal 上挂满失效监听。判据只留这一份，
 * 各资源的差异（用哪个 signal、迟到清理怎么做、非中止失败是否脱敏）由入参给出。
 */
export async function openCancellableLease<Lease>(input: {
  readonly signal: AbortSignal;
  readonly open: () => Promise<Lease>;
  readonly closeLate: (lease: unknown) => Promise<void>;
  /** 非中止的开启失败：缺省原样抛出；给了文案就换成一条脱敏的 TypeError。 */
  readonly openFailureMessage?: string;
}): Promise<Lease> {
  const { signal } = input;
  if (signal.aborted) throw signal.reason;
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abortListener = () => reject(signal.reason);
    signal.addEventListener('abort', abortListener, { once: true });
    if (signal.aborted) abortListener();
  });
  const opening = Promise.resolve().then(() => {
    if (signal.aborted) throw signal.reason;
    return input.open();
  });
  let lease: Lease;
  try {
    lease = await Promise.race([opening, aborted]);
  } catch (error) {
    if (signal.aborted) {
      void opening.then(input.closeLate, () => undefined);
      throw error;
    }
    if (input.openFailureMessage !== undefined) throw new TypeError(input.openFailureMessage);
    throw error;
  } finally {
    if (abortListener !== undefined) signal.removeEventListener('abort', abortListener);
  }
  if (signal.aborted) {
    await input.closeLate(lease);
    throw signal.reason;
  }
  return lease;
}

/**
 * 租约形状不合法时的统一出口：先尽力关掉它，再抛一条脱敏的公开错误。
 *
 * `tracker` 缺省表示这种资源不做「同一对象重复关闭」去重（workspace 就是这样），
 * 给了 tracker 则先登记再关，避免同一个 lease 被关两次。
 */
export async function rejectInvalidLease(input: {
  readonly lease: unknown;
  readonly message: string;
  readonly tracker?: WeakSet<object>;
  readonly close?: unknown;
}): Promise<never> {
  const { lease, tracker } = input;
  if (lease !== null && typeof lease === 'object' && !(tracker?.has(lease) ?? false)) {
    tracker?.add(lease);
    try {
      const close = input.close !== undefined ? input.close : Reflect.get(lease, 'close');
      if (typeof close === 'function') await Reflect.apply(close, lease, []);
    } catch {
      // 公开失败仍然只是一条脱敏的 resource-open 错误，不泄漏 provider 细节。
    }
  }
  throw new TypeError(input.message);
}

/**
 * Runtime 能力与 provider 必须成对出现：只给一边就是配置错误。
 *
 * 两条文案由各资源自带，判据只有一份。
 */
export function requireCapabilityPairing(input: {
  readonly capabilityDeclared: boolean;
  readonly providerPresent: boolean;
  readonly providerRequiresCapabilityMessage: string;
  readonly capabilityRequiresProviderMessage: string;
}): void {
  if (input.providerPresent && !input.capabilityDeclared) {
    throw new TypeError(input.providerRequiresCapabilityMessage);
  }
  if (!input.providerPresent && input.capabilityDeclared) {
    throw new TypeError(input.capabilityRequiresProviderMessage);
  }
}

export interface IdentityFacetProvider {
  readonly providerId: string;
  readonly version: string;
  readonly fingerprintFacets?: unknown;
}

/**
 * 把 provider 身份折进 Runtime 指纹。
 *
 * `derivation` 与 `providerKey` 是**冻结的摘要输入**：改动任何一个都会换掉运行时身份摘要，
 * 进而破坏跨版本可比性，所以它们由调用方按原样传入，不在这里派生。
 */
export function bindProviderIdentity(input: {
  readonly identity: RuntimeIdentity;
  readonly provider: IdentityFacetProvider | undefined;
  readonly derivation: string;
  readonly providerKey: string;
}): RuntimeIdentity {
  const { provider } = input;
  if (provider === undefined) return input.identity;
  return deepFreezeCanonicalJson(RuntimeIdentitySchema.parse({
    ...structuredClone(input.identity),
    fingerprint: digestCanonicalJson({
      derivation: input.derivation,
      executorIdentity: input.identity,
      [input.providerKey]: {
        providerId: provider.providerId,
        version: provider.version,
        ...(provider.fingerprintFacets === undefined
          ? {}
          : { fingerprintFacets: provider.fingerprintFacets }),
      },
    }),
  }));
}

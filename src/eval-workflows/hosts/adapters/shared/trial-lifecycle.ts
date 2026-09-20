import { canonicalizeJson } from '../../../../eval-core/contracts/index.js';

/** Trial 上用来核对密封 Target 绑定的那三个字段。 */
export interface SealedBindingTrial {
  readonly protocolId: string;
  readonly targetId: string;
  readonly targetConfig?: unknown;
}

export interface SealedTargetBinding {
  readonly protocolId: string;
  readonly targetId: string;
  readonly sealedTargetConfig?: unknown;
}

export type TrialBindingFailure = (
  code: string,
  kind: 'infrastructure',
  message: string,
) => never;

/**
 * 开 Trial 前核对它确实属于密封的 Target 绑定。
 *
 * 每个宿主适配器都必须做这一步：绑定对不上说明拿到的 Trial 不是这份 Target 的，
 * 继续执行会把别的 Target 的产物记到这次测量上。错误码与文案由各宿主自带，
 * 判据只有一份。
 */
export function assertTrialMatchesSealedBinding(input: {
  readonly trial: SealedBindingTrial;
  readonly binding: SealedTargetBinding;
  readonly mismatchCode: string;
  readonly hostLabel: string;
  readonly fail: TrialBindingFailure;
}): void {
  const { trial, binding } = input;
  if (
    trial.protocolId !== binding.protocolId
    || trial.targetId !== binding.targetId
    || canonicalizeJson(trial.targetConfig ?? null)
      !== canonicalizeJson(binding.sealedTargetConfig ?? null)
  ) {
    input.fail(
      input.mismatchCode,
      'infrastructure',
      `${input.hostLabel} trial does not match the sealed Target binding.`,
    );
  }
}

export interface TrialSlot {
  acquireTrial(): void;
  releaseTrial(): Promise<void>;
}

/**
 * 占用一个 Trial 名额再开工作区；开失败必须把名额还回去。
 *
 * 少了 catch 里的 releaseTrial，run 级并发额度会随每次失败永久泄漏。
 */
export async function withTrialSlot<TrialState>(input: {
  readonly runState: TrialSlot;
  readonly open: () => Promise<TrialState>;
}): Promise<TrialState> {
  input.runState.acquireTrial();
  try {
    return await input.open();
  } catch (error) {
    await input.runState.releaseTrial();
    throw error;
  }
}

/** 关 Trial：先关工作区，无论成败都归还名额。 */
export async function releaseTrialSlot(input: {
  readonly runState: TrialSlot;
  readonly close: () => Promise<void>;
}): Promise<void> {
  try {
    await input.close();
  } finally {
    await input.runState.releaseTrial();
  }
}

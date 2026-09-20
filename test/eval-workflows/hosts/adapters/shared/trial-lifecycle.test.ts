import { describe, expect, it } from 'vitest';
import {
  assertTrialMatchesSealedBinding,
  releaseTrialSlot,
  withTrialSlot,
} from '../../../../../src/eval-workflows/hosts/adapters/shared/trial-lifecycle.js';

const fail = (code: string, kind: 'infrastructure', message: string): never => {
  throw new Error(`${code}|${kind}|${message}`);
};

const sealedBinding = {
  protocolId: 'claude-cli/v1',
  targetId: 'target-1',
  sealedTargetConfig: { model: 'sonnet', tools: ['Read'] },
};

const boundTrial = {
  protocolId: 'claude-cli/v1',
  targetId: 'target-1',
  targetConfig: { model: 'sonnet', tools: ['Read'] },
};

function counter() {
  const state = { acquired: 0, released: 0 };
  return {
    state,
    runState: {
      acquireTrial: () => {
        state.acquired += 1;
      },
      releaseTrial: async () => {
        state.released += 1;
      },
    },
  };
}

describe('宿主 Trial 生命周期共享判据', () => {
  it('绑定三项全等才放行；协议、Target 或密封配置任一不同都按宿主错误码 fail-closed', () => {
    expect(() => assertTrialMatchesSealedBinding({
      trial: boundTrial,
      binding: sealedBinding,
      mismatchCode: 'OMK_CLAUDE_CLI_TRIAL_MISMATCH',
      hostLabel: 'Claude CLI',
      fail,
    })).not.toThrow();

    const mismatched = [
      { ...boundTrial, protocolId: 'codex-cli/v1' },
      { ...boundTrial, targetId: 'target-2' },
      { ...boundTrial, targetConfig: { model: 'sonnet', tools: ['Write'] } },
      { ...boundTrial, targetConfig: { model: 'sonnet', tools: ['Read', 'Write'] } },
    ];
    for (const trial of mismatched) {
      expect(() => assertTrialMatchesSealedBinding({
        trial,
        binding: sealedBinding,
        mismatchCode: 'OMK_CLAUDE_CLI_TRIAL_MISMATCH',
        hostLabel: 'Claude CLI',
        fail,
      })).toThrow('OMK_CLAUDE_CLI_TRIAL_MISMATCH|infrastructure|Claude CLI trial does not match the sealed Target binding.');
    }
  });

  it('密封配置按规范化 JSON 比较：键序无关，缺省与 null 同义，多一个键就不算同一份', () => {
    const check = (trial: object, binding: object): string | undefined => {
      try {
        assertTrialMatchesSealedBinding({
          trial,
          binding,
          mismatchCode: 'OMK_TEST_TRIAL_MISMATCH',
          hostLabel: 'Test',
          fail,
        });
        return undefined;
      } catch (error) {
        return (error as Error).message;
      }
    };
    expect(check(boundTrial, { ...sealedBinding, sealedTargetConfig: { tools: ['Read'], model: 'sonnet' } }))
      .toBeUndefined();
    expect(check({ ...boundTrial, targetConfig: undefined }, { ...sealedBinding, sealedTargetConfig: undefined }))
      .toBeUndefined();
    expect(check({ ...boundTrial, targetConfig: null }, { ...sealedBinding, sealedTargetConfig: undefined }))
      .toBeUndefined();
    expect(check({ ...boundTrial, targetConfig: { model: 'sonnet' } }, sealedBinding))
      .toContain('OMK_TEST_TRIAL_MISMATCH');
  });

  it('开 Trial 失败必须归还刚占用的名额，成功时不还', async () => {
    const { state, runState } = counter();
    await expect(withTrialSlot({
      runState,
      open: async () => {
        throw new Error('workspace unavailable');
      },
    })).rejects.toThrow('workspace unavailable');
    expect({ ...state }).toEqual({ acquired: 1, released: 1 });

    const trialState = await withTrialSlot({ runState, open: async () => ({ workingDirectory: '/tmp/trial' }) });
    expect(trialState).toEqual({ workingDirectory: '/tmp/trial' });
    expect({ ...state }).toEqual({ acquired: 2, released: 1 });
  });

  it('关 Trial 时即使关工作区失败也要归还名额，并把失败原样抛出', async () => {
    const { state, runState } = counter();
    await releaseTrialSlot({ runState, close: async () => {} });
    expect(state.released).toBe(1);

    await expect(releaseTrialSlot({
      runState,
      close: async () => {
        throw new Error('close failed');
      },
    })).rejects.toThrow('close failed');
    expect(state.released).toBe(2);
  });
});

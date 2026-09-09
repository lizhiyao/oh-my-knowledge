import { describe, expect, it } from 'vitest';
import { formatEvaluationInputFailure, formatEvaluationSummary } from '../../src/cli/lib/eval-output.js';
import { CliEvaluationInputError } from '../../src/eval-workflows/hosts/application.js';

const outcome = {
  projectionKind: 'core-cli-run-outcome', runId: 'acceptance-run',
  status: { runStatus: 'completed', evidenceStatus: 'complete', conclusionStatus: 'conclusive' },
  stages: {
    execution: { coverage: { planned: 6, succeeded: 6, failed: 0, cancelled: 0, budgetCensored: 0, notStarted: 0 } },
    evaluation: { coverage: { planned: 6, completed: 6, failed: 0, sourceUnavailable: 0 } },
  },
  decision: { decisionStatus: 'decided', verdict: 'UNDERPOWERED', reasonCodes: ['comparison-sample-size-below-minimum'] },
  gate: { gateStatus: 'skipped', reasonCodes: ['core-report-only'] },
};

describe('eval terminal output', () => {
  it('shows deduplicated execution reasons and the Codex upgrade remedy', () => {
    const failed = { ...outcome, diagnostic: { findings: [
      { severity: 'error', reasonCode: 'OMK_CODEX_CLI_UPGRADE_REQUIRED' },
      { severity: 'error', reasonCode: 'OMK_CODEX_CLI_UPGRADE_REQUIRED' },
      { severity: 'info', reasonCode: 'not-applicable' },
    ] } };
    const text = formatEvaluationSummary(failed, 'zh');
    expect(text.match(/OMK_CODEX_CLI_UPGRADE_REQUIRED/g)).toHaveLength(1);
    expect(text).toContain('codex --version');
    expect(text).toContain('切换模型会改变测量条件');
    expect(text).not.toContain('not-applicable');
    expect(formatEvaluationSummary(failed, 'en')).toContain('upgrade the CLI');
  });

  it.each([
    ['OMK_CODEX_CLI_SPAWN_FAILED', 'codex --version', 'claude --version'],
    ['OMK_CODEX_CLI_STDIN_UNAVAILABLE', 'codex --version', 'claude --version'],
    ['OMK_CLAUDE_CLI_SPAWN_FAILED', 'claude --version', 'codex --version'],
    ['OMK_CLAUDE_CLI_STDIN_UNAVAILABLE', 'claude --version', 'codex --version'],
  ])('shows the correct executable check for %s in both languages', (reasonCode, command, otherCommand) => {
    for (const lang of ['zh', 'en'] as const) {
      const text = formatEvaluationSummary({ ...outcome,
        diagnostic: { findings: [{ severity: 'error', reasonCode }] },
      }, lang);
      expect(text).toContain(command);
      expect(text).not.toContain(otherCommand);
      expect(text).not.toMatch(/升级|upgrade|cli\.run\./);
    }
  });

  it.each([
    ['OMK_CODEX_CLI_EXIT_NONZERO', 'Codex CLI', 'Claude Code'],
    ['OMK_CODEX_CLI_TURN_FAILED', 'Codex CLI', 'Claude Code'],
    ['OMK_CLAUDE_CLI_EXIT_NONZERO', 'Claude Code CLI', 'Codex'],
    ['OMK_CLAUDE_CLI_TURN_FAILED', 'Claude Code CLI', 'Codex'],
    ['OMK_CLAUDE_CLI_EXECUTION_FAILED', 'Claude Code CLI', 'Codex'],
  ])('does not diagnose generic failure %s as requiring an upgrade', (reasonCode, tool, otherTool) => {
    const failed = { ...outcome, diagnostic: { findings: [{ severity: 'error', reasonCode }] } };
    const zh = formatEvaluationSummary(failed, 'zh');
    const en = formatEvaluationSummary(failed, 'en');
    expect(zh).toContain(`${tool} 调用失败`);
    expect(zh).toContain('当前错误不能确定是否需要升级');
    expect(en).toContain(`${tool} failed`);
    expect(en).toContain('does not establish that an upgrade is needed');
    expect(en).toContain('Keep the same model and cases');
    expect(zh + en).not.toContain(otherTool);
    expect(zh + en).not.toContain('cli.run.');
  });

  it('deduplicates remedies across codes and stages while preserving both tools and the source', () => {
    const failed = { ...outcome,
      diagnostic: { findings: [
        { severity: 'error', reasonCode: 'OMK_CLAUDE_CLI_EXIT_NONZERO', stage: 'execution' },
        { severity: 'error', reasonCode: 'OMK_CLAUDE_CLI_TURN_FAILED', stage: 'evaluation' },
        { severity: 'error', reasonCode: 'OMK_CODEX_CLI_UPGRADE_REQUIRED', stage: 'evaluation' },
      ] },
      gate: { ...outcome.gate, reasonCodes: ['OMK_CLAUDE_CLI_EXIT_NONZERO'] },
    };
    const before = structuredClone(failed);
    const text = formatEvaluationSummary(failed, 'zh');
    expect(text.match(/Claude Code CLI 调用失败/g)).toHaveLength(1);
    expect(text.match(/codex --version/g)).toHaveLength(1);
    expect(text).toContain('OMK_CLAUDE_CLI_TURN_FAILED');
    expect(failed).toEqual(before);
  });

  it('does not infer CLI remedies from SDK/API failures, unknown codes, or non-error findings', () => {
    const text = formatEvaluationSummary({ ...outcome, diagnostic: { findings: [
      ...['OMK_CODEX_SDK_TURN_FAILED', 'OMK_CLAUDE_SDK_EXECUTION_FAILED',
        'OMK_OPENAI_API_FAILED', 'OMK_CLAUDE_CLI_UPGRADE_REQUIRED', 'OMK_CODEX_CLI_CANCELLED',
        'OMK_CODEX_CLI_UPGRADE_REQUIRED_EXTRA', 'constructor', '__proto__',
      ].map((reasonCode) => ({ severity: 'error', reasonCode })),
      { severity: 'info', reasonCode: 'OMK_CODEX_CLI_UPGRADE_REQUIRED' },
      { severity: 'warning', reasonCode: 'OMK_CLAUDE_CLI_SPAWN_FAILED' },
    ] } }, 'en');
    expect(text).not.toMatch(/--version|upgrade|Codex CLI|Claude Code CLI|cli\.run\./);
    expect(text).toContain('OMK_CLAUDE_SDK_EXECUTION_FAILED');
  });

  it('shows the verdict and sample-size action even when report-only exits successfully', () => {
    const before = structuredClone(outcome);
    const text = formatEvaluationSummary(outcome, 'zh');
    expect(text).toContain('评测结论：UNDERPOWERED');
    expect(text).toContain('当前不能作为发布依据');
    expect(text).toContain('6/6 成功');
    expect(text).toContain('comparison-sample-size-below-minimum');
    expect(text).toContain('core-report-only');
    expect(outcome).toEqual(before);
  });

  it('prioritizes missing evidence over a supplied positive verdict', () => {
    const text = formatEvaluationSummary({ ...outcome,
      status: { ...outcome.status, evidenceStatus: 'unresolvable', conclusionStatus: 'inconclusive' },
      stages: { ...outcome.stages, execution: { coverage: { ...outcome.stages.execution.coverage, succeeded: 0, failed: 6 } } },
      decision: { ...outcome.decision, verdict: 'PROGRESS' },
    }, 'en');
    expect(text).toContain('0/6 succeeded, 6 failed');
    expect(text).toContain('inspect failed calls and missing evidence');
    expect(text).not.toContain('entering your release process');
  });

  it('keeps a blocked gate visible when the verdict is positive', () => {
    const text = formatEvaluationSummary({ ...outcome,
      decision: { ...outcome.decision, verdict: 'PROGRESS' },
      gate: { gateStatus: 'blocked', reasonCodes: ['policy-blocked'] },
    }, 'en');
    expect(text).toContain('gate blocked');
    expect(text).toContain('gate conditions');
    expect(text).not.toContain('entering your release process');
  });

  it('shows a failed decision as missing verdict with its error code', () => {
    const text = formatEvaluationSummary({ ...outcome,
      decision: { decisionStatus: 'failed', errorCode: 'decision-source-unavailable' },
    }, 'zh');
    expect(text).toContain('评测结论：—');
    expect(text).toContain('decision-source-unavailable');
    expect(text).toContain('缺失证据');
  });

  it('preserves non-run outcomes instead of inventing a run verdict', () => {
    const series = { projectionKind: 'core-cli-series-outcome', runs: ['one', 'two'] };
    expect(JSON.parse(formatEvaluationSummary(series, 'zh'))).toEqual(series);
  });

  it('provides a localized executor-path remedy without leaking the command', () => {
    const error = new CliEvaluationInputError({
      code: 'CLI_INPUT_RESOLUTION_FAILED', fieldPath: 'targetRuntime.executorId',
      sourcePath: 'node script.mjs --token private-value', message: 'internal failure',
    });
    expect(formatEvaluationInputFailure(error, 'zh')).toContain('shebang');
    expect(formatEvaluationInputFailure(error, 'en')).toContain('one existing executable file');
    expect(formatEvaluationInputFailure(error, 'zh')).not.toContain('private-value');
    expect(formatEvaluationInputFailure(new Error('different failure'), 'en')).toBe('different failure');
  });
});

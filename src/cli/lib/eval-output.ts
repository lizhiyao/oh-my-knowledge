import type { CoreCliRunOutcome } from '../../eval-workflows/projections/contracts.js';
import { CliEvaluationInputError } from '../../eval-workflows/hosts/application.js';
import { tCli, type CliLang } from './i18n.js';
import type { CliMessageKey } from './i18n-dict.js';

const VERDICT_HINTS: Readonly<Record<string, CliMessageKey>> = {
  PROGRESS: 'cli.run.next.progress',
  REGRESSION: 'cli.run.next.regression',
  NOISE: 'cli.run.next.noise',
  UNDERPOWERED: 'cli.run.next.underpowered',
  CAUTIOUS: 'cli.run.next.inspect',
  SOLO: 'cli.run.next.solo',
};

// Match adapter reason codes exactly; raw errors and tool names cannot establish a cause.
const DIAGNOSTIC_HINTS = new Map<string, CliMessageKey>([
  ['OMK_CODEX_CLI_UPGRADE_REQUIRED', 'cli.run.codex_cli_upgrade_hint'],
  ['OMK_CODEX_CLI_SPAWN_FAILED', 'cli.run.codex_cli_start_hint'],
  ['OMK_CODEX_CLI_STDIN_UNAVAILABLE', 'cli.run.codex_cli_start_hint'],
  ['OMK_CODEX_CLI_EXIT_NONZERO', 'cli.run.codex_cli_failure_hint'],
  ['OMK_CODEX_CLI_TURN_FAILED', 'cli.run.codex_cli_failure_hint'],
  ['OMK_CLAUDE_CLI_SPAWN_FAILED', 'cli.run.claude_cli_start_hint'],
  ['OMK_CLAUDE_CLI_STDIN_UNAVAILABLE', 'cli.run.claude_cli_start_hint'],
  ['OMK_CLAUDE_CLI_EXIT_NONZERO', 'cli.run.claude_cli_failure_hint'],
  ['OMK_CLAUDE_CLI_TURN_FAILED', 'cli.run.claude_cli_failure_hint'],
  ['OMK_CLAUDE_CLI_EXECUTION_FAILED', 'cli.run.claude_cli_failure_hint'],
]);

export function formatEvaluationInputFailure(error: unknown, lang: CliLang): string {
  if (error instanceof CliEvaluationInputError
      && error.code === 'CLI_INPUT_RESOLUTION_FAILED'
      && error.fieldPath === 'targetRuntime.executorId') {
    return tCli('cli.run.custom_executor_path', lang);
  }
  return error instanceof Error ? error.message : String(error);
}

export function formatEvaluationSummary(output: unknown, lang: CliLang): string {
  if (!output || typeof output !== 'object'
      || !('projectionKind' in output) || output.projectionKind !== 'core-cli-run-outcome') {
    return `${JSON.stringify(output, null, 2)}\n`;
  }
  const result = output as CoreCliRunOutcome;
  const decision = result.decision;
  const verdict = decision?.decisionStatus === 'decided' ? decision.verdict : '—';
  const execution = result.stages.execution.coverage;
  const evaluation = result.stages.evaluation.coverage;
  const incomplete = result.status.runStatus !== 'completed'
    || result.status.evidenceStatus !== 'complete'
    || result.status.conclusionStatus !== 'conclusive'
    || result.decision?.decisionStatus !== 'decided';
  const next = incomplete ? 'cli.run.next.evidence'
    : result.gate.gateStatus === 'blocked' && verdict === 'PROGRESS' ? 'cli.run.next.inspect'
      : Object.hasOwn(VERDICT_HINTS, verdict) ? VERDICT_HINTS[verdict]! : 'cli.run.next.inspect';
  const reasons = [...new Set([
    ...(result.diagnostic?.findings.filter((finding) => finding.severity === 'error')
      .map((finding) => finding.reasonCode) ?? []),
    ...(decision && 'reasonCodes' in decision ? decision.reasonCodes
      : decision?.decisionStatus === 'failed' ? [decision.errorCode] : []),
    ...result.gate.reasonCodes,
  ])];
  const hints = new Set<CliMessageKey>();
  for (const reason of reasons) {
    const hint = DIAGNOSTIC_HINTS.get(reason);
    if (hint) hints.add(hint);
  }
  return [
    tCli('cli.run.summary.verdict', lang, { verdict }),
    tCli(next, lang),
    ...[...hints].map((hint) => tCli(hint, lang)),
    tCli('cli.run.summary.execution', lang, { ...execution }),
    tCli('cli.run.summary.evaluation', lang, { ...evaluation }),
    tCli('cli.run.summary.state', lang, {
      run: result.status.runStatus, evidence: result.status.evidenceStatus,
      conclusion: result.status.conclusionStatus, gate: result.gate.gateStatus,
    }),
    ...(reasons.length ? [tCli('cli.run.summary.reasons', lang, { reasons: reasons.join(', ') })] : []),
    tCli('cli.run.summary.run', lang, { runId: result.runId }),
  ].join('\n') + '\n';
}

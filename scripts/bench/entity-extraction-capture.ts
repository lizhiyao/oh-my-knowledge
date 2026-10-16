import { openSync, closeSync, fsyncSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLiveCapture, compareLiveCaptures, executeLiveCapture, prepareLiveCapture, replayLiveCapture } from './entity-capture.js';
import { reviewOutputRoot } from './entity-extraction-review.js';

const HELP = `Entity extraction capture / 实体采集（仓内工具）
prepare --source <file> | --review-bundle <dir> --prompt <file> --config <file> --out <dir> [--wire-schema <file>]
check --plan <dir>
execute-one --plan <dir> --permission <file> --authorize-plan <sha256:id> --slot <slot-id>
replay --plan <dir> [--out <new-external-report.json>]
compare --left <dir> --right <dir>
Default: zero requests. Each execute-one requests one predeclared slot only.
默认零请求。execute-one 须明确许可；每次只推进一个预定 slot，不自动重试。
`;
const FLAGS: Record<string, { required: string[]; optional?: string[] }> = {
  prepare: { required: ['--prompt', '--config', '--out'], optional: ['--source', '--review-bundle', '--wire-schema'] },
  check: { required: ['--plan'] }, 'execute-one': { required: ['--plan', '--permission', '--authorize-plan', '--slot'] },
  replay: { required: ['--plan'], optional: ['--out'] }, compare: { required: ['--left', '--right'] },
};
export function parseCaptureArguments(args: string[]) {
  if (!args.length || (args.length === 1 && ['--help', '-h'].includes(args[0]))) return null;
  const [command, ...pairs] = args; const spec = FLAGS[command];
  if (!spec || pairs.length % 2) throw new Error('Expected a command and unique named argument/value pairs.');
  const values: Record<string, string> = {};
  for (let index = 0; index < pairs.length; index += 2) {
    const name = pairs[index]; const value = pairs[index + 1];
    if (![...spec.required, ...(spec.optional ?? [])].includes(name) || Object.hasOwn(values, name) || !value?.trim() || value.startsWith('--')) throw new Error('Unknown, duplicate or missing argument.');
    values[name] = value;
  }
  if (spec.required.some(name => !values[name]) || (command === 'prepare' && !!values['--source'] === !!values['--review-bundle'])) throw new Error('Missing required arguments or ambiguous source.');
  return { command, values };
}
async function main() {
  let args: ReturnType<typeof parseCaptureArguments>;
  try { args = parseCaptureArguments(process.argv.slice(2)); } catch (error) { process.stderr.write(String(error) + '\n' + HELP); process.exitCode = 2; return; }
  if (!args) { process.stdout.write(HELP); return; }
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const environment = Object.freeze({ ...process.env }); const { command, values } = args;
  const controller = new AbortController(); const cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    let result: unknown;
    if (command === 'prepare') {
      const plan = await prepareLiveCapture({ repository, output: values['--out'], source: values['--source'], reviewBundle: values['--review-bundle'],
        prompt: values['--prompt'], config: values['--config'], wireSchema: values['--wire-schema'] }, environment);
      result = { planId: plan.planId, slots: plan.slots.length, source: plan.source, requestsByThisCommand: 0, permissionStatus: 'pending' };
    } else if (command === 'check') {
      const checked = await checkLiveCapture(repository, values['--plan'], environment);
      result = { planId: checked.bundle.plan.planId, executable: checked.executable, reasons: checked.reasons,
        profile: checked.profile ?? null, permissionRequired: true, requestsByThisCommand: 0 };
      if (!checked.executable) process.exitCode = 1;
    } else if (command === 'execute-one') {
      const attempt = await executeLiveCapture({ repository, directory: values['--plan'], permission: values['--permission'],
        authorizePlan: values['--authorize-plan'], slotId: values['--slot'], signal: controller.signal }, environment);
      result = attempt; if (attempt.outcome !== 'output') process.exitCode = 1;
    } else if (command === 'replay') {
      const report = await replayLiveCapture(repository, values['--plan']);
      if (values['--out']) {
        const path = reviewOutputRoot(repository, values['--out']); const fd = openSync(path, 'wx', 0o600);
        try { writeFileSync(fd, JSON.stringify(report, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
      }
      result = { planId: report.planId, recorded: report.records.length, unattempted: report.unattempted.length, blocked: report.blocked,
        provenance: report.provenance, authority: report.authority, requestsByThisCommand: 0,
        semanticReview: report.semanticReview, independentHumanReview: report.independentHumanReview, qualityConclusion: report.qualityConclusion };
    } else result = await compareLiveCaptures(repository, values['--left'], values['--right']);
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) { process.stderr.write(String(error) + '\n'); process.exitCode = 1; }
  finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) void main();

import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HELP = `Study output panel / 研究输出多人复核（仓内离线工具）
prepare --evidence <evidence.json> --roster <roster.json> --mode prospective|retrospective --output <new-external-directory>
report --evidence <same-evidence.json> --panel <panel.json> --submission <submission.json> [--adjudication <adjudication.json>] --output <new-external-directory>
Zero model calls. Original single-review receipts are preserved. Agreement never establishes quality acceptance.
零模型调用；保留全部原始单人回执。一致性不代表质量验收；缺项和不确定不计同意。
`;
const flags = {
  prepare: { required: ['--evidence', '--roster', '--mode', '--output'], optional: [] },
  report: { required: ['--evidence', '--panel', '--submission', '--output'], optional: ['--adjudication'] },
};
export function parseKnowledgeStudyPanelArguments(args: string[]) {
  if (!args.length || args.length === 1 && ['--help', '-h'].includes(args[0])) return null;
  const [command, ...pairs] = args;
  if (!Object.hasOwn(flags, command) || pairs.length % 2) throw new Error('Expected prepare/report with unique flag/value pairs.');
  const name = command as keyof typeof flags, spec = flags[name], values: Record<string, string> = {};
  for (let index = 0; index < pairs.length; index += 2) {
    const flag = pairs[index], value = pairs[index + 1];
    if (![...spec.required, ...spec.optional].includes(flag) || Object.hasOwn(values, flag) || !value?.trim() || value.startsWith('--')) throw new Error('Invalid panel argument.');
    values[flag] = value;
  }
  if (spec.required.some(flag => !values[flag]) || name === 'prepare' && !['prospective', 'retrospective'].includes(values['--mode'])) throw new Error('Missing or invalid panel argument.');
  return { command: name, values };
}
async function main() {
  let parsed: ReturnType<typeof parseKnowledgeStudyPanelArguments>;
  try { parsed = parseKnowledgeStudyPanelArguments(process.argv.slice(2)); }
  catch { process.stderr.write(HELP); process.exitCode = 2; return; }
  if (!parsed) { process.stdout.write(HELP); return; }
  try {
    const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
    // Fixed built composition root. Neither portable evidence nor review files can select executable code.
    const host = await import(pathToFileURL(resolve(repository, 'dist/cli/runtime/knowledge-study-panel.js')).href) as {
      executeLocalExtractionStudyPanel(input: { command: 'prepare' | 'report'; values: Record<string, string>; repository: string }): { exitCode: number; [key: string]: unknown };
    };
    const result = host.executeLocalExtractionStudyPanel({ ...parsed, repository });
    process.stdout.write(JSON.stringify(result) + '\n'); process.exitCode = result.exitCode;
  } catch { process.stderr.write('knowledge_study_panel_failed: 输入、名单、原始回执或冻结证据未通过；未产生质量通过结论。\n'); process.exitCode = 1; }
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) void main();

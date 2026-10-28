import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

const HELP = `Knowledge extraction study / 知识提取研究（仓内工具）
prepare --workspace <existing-directory> --study <new-external-directory> --corpus <json> --config <json>
run --workspace <directory> --study <directory> --slot <slot-id> --authorize-plan <sha256:id>
report --workspace <directory> --study <directory> --output <new-external-directory>
       [--author-review <json>] [--reference-review <json>] [--output-review <json>]
prepare/report: zero model calls. run: frozen typed generation is unsupported by the canonical body host.
prepare/report 零模型调用。run 明确拒绝旧 typed 生成计划；请使用 observe knowledge generate 或新的 body 测量协议，不冒充旧计划继续可比。
`;
const FLAGS = {
  prepare: { required: ['--workspace', '--study', '--corpus', '--config'], optional: [] },
  run: { required: ['--workspace', '--study', '--slot', '--authorize-plan'], optional: [] },
  report: { required: ['--workspace', '--study', '--output'], optional: ['--author-review', '--reference-review', '--output-review'] },
};
export function parseKnowledgeStudyArguments(args: string[]) {
  if (!args.length || args.length === 1 && ['--help', '-h'].includes(args[0])) return null;
  const [command, ...pairs] = args;
  if (!Object.hasOwn(FLAGS, command) || pairs.length % 2) throw new Error('Expected prepare/run/report and unique flag/value pairs.');
  const name = command as keyof typeof FLAGS, spec = FLAGS[name], values: Record<string, string> = {};
  for (let index = 0; index < pairs.length; index += 2) {
    const flag = pairs[index], value = pairs[index + 1];
    if (![...spec.required, ...spec.optional].includes(flag) || Object.hasOwn(values, flag) || !value?.trim() || value.startsWith('--')) throw new Error('Unknown, duplicate or missing study argument.');
    values[flag] = value;
  }
  if (spec.required.some(flag => !values[flag])) throw new Error('Missing required study argument.');
  return { command: name, values };
}
async function main() {
  let parsed: ReturnType<typeof parseKnowledgeStudyArguments>;
  try { parsed = parseKnowledgeStudyArguments(process.argv.slice(2)); }
  catch { process.stderr.write(HELP); process.exitCode = 2; return; }
  if (!parsed) { process.stdout.write(HELP); return; }
  const runnerFile = fileURLToPath(import.meta.url), repository = resolve(dirname(runnerFile), '..', '..');
  const controller = new AbortController(), cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    // Fixed production composition root; evidence or arguments cannot select executable code.
    const host = await import(pathToFileURL(resolve(repository, 'dist/cli/runtime/knowledge-study.js')).href) as {
      executeLocalExtractionStudy(input: { command: 'prepare' | 'run' | 'report'; values: Record<string, string>; repository: string;
        runnerFile: string; environment: NodeJS.ProcessEnv; signal?: AbortSignal }): Promise<{ exitCode: number; [key: string]: unknown }>;
    };
    const result = await host.executeLocalExtractionStudy({ ...parsed, repository, runnerFile, environment: process.env, signal: controller.signal });
    process.stdout.write(JSON.stringify(result) + '\n'); process.exitCode = result.exitCode;
  } catch { process.stderr.write('knowledge_study_failed: 输入、冻结身份或执行未通过；原文和原生证据保留在显式研究目录。\n'); process.exitCode = 1; }
  finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) void main();

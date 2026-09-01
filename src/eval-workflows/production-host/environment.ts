import type { SampleEnvironment } from '../../inputs/contracts/sample.js';

/**
 * 把 sample.environment 渲染成自然语言段落,放在用户 prompt 前。
 * 这是题设上下文,不会修改 PATH、物化文件或改变 runtime;LLM 可据此跳过
 * which / test -f 等可用性探测,直接进入 skill 描述的工作流。
 *
 * 输出 null 表示 sample 没声明 environment,prompt 不变。
 */
export function renderEnvironmentSection(env: SampleEnvironment | undefined): string | null {
  if (!env) return null;
  const lines: string[] = [];
  if (env.cli_available && env.cli_available.length > 0) {
    lines.push('- 题设声明可用的 CLI（仅作上下文，不修改 PATH）：');
    for (const c of env.cli_available) lines.push(`  - \`${c}\``);
  }
  if (env.files_available && env.files_available.length > 0) {
    lines.push('- 题设引用的文件路径（仅作上下文，不会在 cwd 物化）：');
    for (const f of env.files_available) lines.push(`  - \`${f}\``);
  }
  if (env.notes && env.notes.trim()) {
    lines.push(`- 备注：${env.notes.trim()}`);
  }
  if (lines.length === 0) return null;
  return [
    '## 题设环境声明（仅作上下文）',
    '',
    ...lines,
    '',
    '请按以上题设进入 skill 描述的主流程，**不要额外做 `find` / `which` / `test -f` 等可用性探测**。这些声明不会自动创建文件或修改 runtime 环境。',
  ].join('\n');
}

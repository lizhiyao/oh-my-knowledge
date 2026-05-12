import type { Artifact, Sample, SampleEnvironment, Task } from '../types/index.js';

/**
 * 把 sample.environment 渲染成自然语言段落,放在用户 prompt 前。
 * 让 LLM 读到"环境已就绪",跳过 Glob / find / which / Read 这些环境探测,
 * 直接进入 skill 描述的工作流 — 评测信号纯,mock 设计也简化(不用 mock 探测命令)。
 *
 * 输出 null 表示 sample 没声明 environment,prompt 不变。
 */
export function renderEnvironmentSection(env: SampleEnvironment | undefined): string | null {
  if (!env) return null;
  const lines: string[] = [];
  if (env.cli_available && env.cli_available.length > 0) {
    lines.push('- 已安装 CLI(已在 PATH,无需 `which` / `command -v` / `type` 探测):');
    for (const c of env.cli_available) lines.push(`  - \`${c}\``);
  }
  if (env.files_available && env.files_available.length > 0) {
    lines.push('- 已存在文件(无需 Glob / `Read` / `test -f` 探测):');
    for (const f of env.files_available) lines.push(`  - \`${f}\``);
  }
  if (env.notes && env.notes.trim()) {
    lines.push(`- 备注:${env.notes.trim()}`);
  }
  if (lines.length === 0) return null;
  return [
    '## 评测环境前置(已就绪,无需探测)',
    '',
    ...lines,
    '',
    '请直接进入 skill 描述的主流程,**不要做环境检查 / `Glob` / `find` / `which` / `test -f` 等探测**。',
  ].join('\n');
}

export function buildTasks(samples: Sample[], variants: string[], skills: Record<string, string | null>): Task[] {
  const artifacts: Artifact[] = variants.map((variant) => ({
    name: variant,
    kind: variant === 'baseline' ? 'baseline' : 'skill',
    source: variant === 'baseline' ? 'baseline' : 'custom',
    content: skills[variant] || null,
  }));
  return buildTasksFromArtifacts(samples, artifacts);
}

export function buildTasksFromArtifacts(samples: Sample[], artifacts: Artifact[]): Task[] {
  const tasks: Task[] = [];

  for (const sample of samples) {
    for (const artifact of artifacts) {
      // user prompt 拼接:[environment 前置段] + sample.prompt + [context 代码块,如有]
      const envSection = renderEnvironmentSection(sample.environment);
      const baseUserPrompt = sample.context
        ? `${sample.prompt}\n\n\`\`\`\n${sample.context}\n\`\`\``
        : sample.prompt;
      const userPrompt = envSection
        ? `${envSection}\n\n---\n\n${baseUserPrompt}`
        : baseUserPrompt;

      tasks.push({
        sample_id: sample.sample_id,
        variant: artifact.name,
        artifact,
        prompt: userPrompt,
        rubric: sample.rubric || null,
        assertions: sample.assertions || null,
        dimensions: sample.dimensions || null,
        artifactContent: artifact.content,
        cwd: artifact.cwd || artifact.skillRoot || sample.cwd || null,
        _sample: sample,
      });
    }
  }

  return tasks;
}

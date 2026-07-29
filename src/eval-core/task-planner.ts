import type { Artifact, Sample, SampleEnvironment, Task } from '../types/index.js';

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
        // 用户显式 cwd > execRoot(隔离副本,dir-skill 执行根) > skillRoot(真源,兜底) > sample.cwd
        cwd: artifact.cwd || artifact.execRoot || artifact.skillRoot || sample.cwd || null,
        _sample: sample,
      });
    }
  }

  return tasks;
}

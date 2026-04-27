import type { Artifact, Sample, Task } from '../types/index.js';

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
      const userPrompt = sample.context
        ? `${sample.prompt}\n\n\`\`\`\n${sample.context}\n\`\`\``
        : sample.prompt;

      tasks.push({
        sample_id: sample.sample_id,
        variant: artifact.name,
        artifact,
        prompt: userPrompt,
        rubric: sample.rubric || null,
        assertions: sample.assertions || null,
        dimensions: sample.dimensions || null,
        artifactContent: artifact.content,
        cwd: artifact.cwd || sample.cwd || null,
        _sample: sample,
      });
    }
  }

  return tasks;
}

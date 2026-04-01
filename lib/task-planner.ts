import type { EvaluandSpec, Sample, Task } from './types.js';

export function buildTasks(samples: Sample[], variants: string[], skills: Record<string, string | null>): Task[] {
  const evaluands: EvaluandSpec[] = variants.map((variant) => ({
    name: variant,
    kind: variant === 'baseline' ? 'baseline' : 'skill',
    source: variant === 'baseline' ? 'baseline' : 'custom',
    content: skills[variant] || null,
  }));
  return buildTasksFromEvaluands(samples, evaluands);
}

export function buildTasksFromEvaluands(samples: Sample[], evaluands: EvaluandSpec[]): Task[] {
  const tasks: Task[] = [];

  for (const sample of samples) {
    for (const evaluand of evaluands) {
      const userPrompt = sample.context
        ? `${sample.prompt}\n\n\`\`\`\n${sample.context}\n\`\`\``
        : sample.prompt;

      tasks.push({
        sample_id: sample.sample_id,
        variant: evaluand.name,
        evaluand,
        prompt: userPrompt,
        rubric: sample.rubric || null,
        assertions: sample.assertions || null,
        dimensions: sample.dimensions || null,
        skillContent: evaluand.content,
        cwd: sample.cwd || null,
        _sample: sample,
      });
    }
  }

  return tasks;
}

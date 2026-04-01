import type { Sample, Task } from './types.js';

export function buildTasks(samples: Sample[], variants: string[], skills: Record<string, string | null>): Task[] {
  const tasks: Task[] = [];

  for (const sample of samples) {
    for (const variant of variants) {
      const userPrompt = sample.context
        ? `${sample.prompt}\n\n\`\`\`\n${sample.context}\n\`\`\``
        : sample.prompt;

      tasks.push({
        sample_id: sample.sample_id,
        variant,
        prompt: userPrompt,
        rubric: sample.rubric || null,
        assertions: sample.assertions || null,
        dimensions: sample.dimensions || null,
        skillContent: skills[variant] || null,
        cwd: sample.cwd || null,
        _sample: sample,
      });
    }
  }

  return tasks;
}

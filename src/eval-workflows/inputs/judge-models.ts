import type { JudgeConfig } from '../instruments/contracts/config.js';

export function parseJudgeModelsArg(raw: string): JudgeConfig[] {
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) {
    throw new Error(`--judge-models cannot be empty`);
  }
  const result: JudgeConfig[] = [];
  const seen = new Set<string>();
  for (const p of parts) {
    const idx = p.indexOf(':');
    if (idx <= 0 || idx === p.length - 1) {
      throw new Error(`--judge-models entry must be 'executor:model' (got "${p}")`);
    }
    const executor = p.slice(0, idx);
    const model = p.slice(idx + 1);
    const key = `${executor}:${model}`;
    if (seen.has(key)) {
      throw new Error(`--judge-models has duplicate entry "${key}"; ensemble 聚合按 executor:model 去重,重复条目会让 N 不可信、agreement 失真`);
    }
    seen.add(key);
    result.push({ executor, model });
  }
  return result;
}


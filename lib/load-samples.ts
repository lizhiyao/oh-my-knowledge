import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import type { Sample } from './types.js';

interface YamlErrorLike {
  mark?: { line: number };
  reason?: string;
  message?: string;
}

export function parseYaml(text: string): unknown {
  try {
    return yaml.load(text);
  } catch (err: unknown) {
    const yamlError = (typeof err === 'object' && err !== null ? err : {}) as YamlErrorLike;
    const line = yamlError.mark ? ` at line ${yamlError.mark.line + 1}` : '';
    throw new Error(`YAML parse error${line}: ${yamlError.reason || yamlError.message || 'unknown error'}`);
  }
}

export function loadSamples(samplesPath: string): Sample[] {
  const rawContent = readFileSync(resolve(samplesPath), 'utf-8');
  const samples: Sample[] = samplesPath.endsWith('.yaml') || samplesPath.endsWith('.yml')
    ? parseYaml(rawContent) as Sample[]
    : JSON.parse(rawContent) as Sample[];

  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error(`无效的样本文件: ${samplesPath}`);
  }

  for (const [i, sample] of samples.entries()) {
    if (!sample.sample_id) throw new Error(`samples[${i}] 缺少必填字段: sample_id`);
    if (!sample.prompt) throw new Error(`samples[${i}] (${sample.sample_id}) 缺少必填字段: prompt`);
  }

  return samples;
}

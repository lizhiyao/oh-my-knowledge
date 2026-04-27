import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import type { Sample } from '../types.js';
import type { DependencyRequirements } from '../eval-core/dependency-checker.js';

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

export interface LoadSamplesResult {
  samples: Sample[];
  requires?: DependencyRequirements;
}

/**
 * Load samples from a JSON or YAML file.
 *
 * Supports two formats:
 * - Array: `[ { sample_id, prompt, ... } ]` (legacy)
 * - Object wrapper: `{ requires?: { tools, files, env }, samples: [...] }`
 */
export function loadSamples(samplesPath: string): LoadSamplesResult {
  const rawContent = readFileSync(resolve(samplesPath), 'utf-8');
  const isYaml = samplesPath.endsWith('.yaml') || samplesPath.endsWith('.yml');
  const parsed: unknown = isYaml ? parseYaml(rawContent) : JSON.parse(rawContent);

  let samples: Sample[];
  let requires: DependencyRequirements | undefined;

  if (Array.isArray(parsed)) {
    // Legacy array format
    samples = parsed as Sample[];
  } else if (typeof parsed === 'object' && parsed !== null && 'samples' in parsed) {
    // Object wrapper format
    const wrapper = parsed as { samples: Sample[]; requires?: DependencyRequirements };
    samples = wrapper.samples;
    requires = wrapper.requires;
  } else {
    throw new Error(`invalid samples file shape: ${samplesPath} (expected an array or an object with a 'samples' field)`);
  }

  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error(`invalid samples file: ${samplesPath}`);
  }

  for (const [i, sample] of samples.entries()) {
    if (!sample.sample_id) throw new Error(`samples[${i}] missing required field: sample_id`);
    if (!sample.prompt) throw new Error(`samples[${i}] (${sample.sample_id}) missing required field: prompt`);
  }

  return { samples, requires };
}

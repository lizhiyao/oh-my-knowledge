import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import type { Sample } from '../types/index.js';
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

  // v0.22 — sample design metadata enums (capability/difficulty/construct/provenance).
  // Pure documentation/diagnostic fields; do NOT participate in grading/judge/verdict.
  const VALID_DIFFICULTY: ReadonlySet<string> = new Set(['easy', 'medium', 'hard']);
  const VALID_PROVENANCE: ReadonlySet<string> = new Set(['human', 'llm-generated', 'production-trace']);

  for (const [i, sample] of samples.entries()) {
    if (!sample.sample_id) throw new Error(`samples[${i}] missing required field: sample_id`);
    if (!sample.prompt) throw new Error(`samples[${i}] (${sample.sample_id}) missing required field: prompt`);

    // v0.22 — validate optional metadata enums; help users typo-check (`'easy?'` etc).
    if (sample.difficulty !== undefined && !VALID_DIFFICULTY.has(sample.difficulty)) {
      throw new Error(
        `samples[${i}] (${sample.sample_id}) invalid difficulty: ${JSON.stringify(sample.difficulty)}, expected one of [easy, medium, hard]`,
      );
    }
    if (sample.provenance !== undefined && !VALID_PROVENANCE.has(sample.provenance)) {
      throw new Error(
        `samples[${i}] (${sample.sample_id}) invalid provenance: ${JSON.stringify(sample.provenance)}, expected one of [human, llm-generated, production-trace]`,
      );
    }
    if (sample.capability !== undefined) {
      if (!Array.isArray(sample.capability)) {
        throw new Error(
          `samples[${i}] (${sample.sample_id}) invalid capability: must be a string array (got ${typeof sample.capability})`,
        );
      }
      for (const [j, cap] of sample.capability.entries()) {
        if (typeof cap !== 'string' || !cap) {
          throw new Error(
            `samples[${i}] (${sample.sample_id}) capability[${j}] must be a non-empty string`,
          );
        }
      }
    }
    if (sample.construct !== undefined && typeof sample.construct !== 'string') {
      throw new Error(
        `samples[${i}] (${sample.sample_id}) invalid construct: must be a string (got ${typeof sample.construct})`,
      );
    }
  }

  return { samples, requires };
}

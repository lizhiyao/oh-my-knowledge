import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
 * Load samples from a single file OR a directory of sample files.
 *
 * File mode (.json / .yaml / .yml):
 * - Array: `[ { sample_id, prompt, ... } ]` (legacy)
 * - Object wrapper: `{ requires?: { tools, files, env }, samples: [...] }`
 *
 * Directory mode (e.g. `<skill>/.omk/`):
 * - Glob `*.{json,yaml,yml}` minus reserved prefixes (report*, health*, _*)
 * - Concat samples in deterministic name-sorted order
 * - Cross-file `sample_id` must be unique
 * - `requires` from each file unioned together
 */
export function loadSamples(samplesPath: string): LoadSamplesResult {
  const abs = resolve(samplesPath);
  if (statSync(abs).isDirectory()) {
    return loadSamplesFromDir(abs);
  }
  return loadSampleFile(abs);
}

/** Pull `.json/.yaml/.yml` siblings out of a directory, skipping omk's own report/health
 *  artifacts and any underscore-prefixed file (the convention for "not a sample"). */
function listSampleFilesInDir(dir: string): string[] {
  const RESERVED = /^(report|health|_)/i;
  return readdirSync(dir)
    .filter((f) => /\.(json|ya?ml)$/i.test(f))
    .filter((f) => !RESERVED.test(f))
    .sort();  // deterministic merge order
}

function loadSamplesFromDir(dir: string): LoadSamplesResult {
  const files = listSampleFilesInDir(dir);
  if (files.length === 0) {
    throw new Error(
      `no sample files found in directory: ${dir} ` +
      `(looking for *.json/*.yaml/*.yml, excluding report*/health*/_* names)`,
    );
  }

  const allSamples: Sample[] = [];
  const seenIds = new Map<string, string>();  // sample_id → first file that defined it
  let mergedRequires: DependencyRequirements | undefined;

  for (const f of files) {
    const path = join(dir, f);
    const single = loadSampleFile(path);
    for (const s of single.samples) {
      const prev = seenIds.get(s.sample_id);
      if (prev) {
        throw new Error(
          `duplicate sample_id "${s.sample_id}" in ${dir}: ` +
          `defined in both "${prev}" and "${f}"`,
        );
      }
      seenIds.set(s.sample_id, f);
    }
    allSamples.push(...single.samples);
    mergedRequires = mergeRequires(mergedRequires, single.requires);
  }
  return { samples: allSamples, requires: mergedRequires };
}

/** Union of string arrays for tools/files/env/preflight; undef when both sides empty. */
function mergeRequires(
  a: DependencyRequirements | undefined,
  b: DependencyRequirements | undefined,
): DependencyRequirements | undefined {
  if (!a) return b;
  if (!b) return a;
  const u = (xs?: string[], ys?: string[]): string[] | undefined => {
    if (!xs && !ys) return undefined;
    return [...new Set([...(xs ?? []), ...(ys ?? [])])];
  };
  const out: DependencyRequirements = {};
  const tools = u(a.tools, b.tools);
  const files = u(a.files, b.files);
  const env = u(a.env, b.env);
  const preflight = u(a.preflight, b.preflight);
  if (tools) out.tools = tools;
  if (files) out.files = files;
  if (env) out.env = env;
  if (preflight) out.preflight = preflight;
  return out;
}

function loadSampleFile(samplesPath: string): LoadSamplesResult {
  const rawContent = readFileSync(samplesPath, 'utf-8');
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

  // sample design metadata enums (capability/difficulty/construct/provenance).
  // Pure documentation/diagnostic fields; do NOT participate in grading/judge/verdict.
  const VALID_DIFFICULTY: ReadonlySet<string> = new Set(['easy', 'medium', 'hard']);
  const VALID_PROVENANCE: ReadonlySet<string> = new Set(['human', 'llm-generated', 'production-trace']);

  for (const [i, sample] of samples.entries()) {
    if (!sample.sample_id || typeof sample.sample_id !== 'string') {
      throw new Error(`samples[${i}] missing or invalid required field: sample_id (must be a non-empty string)`);
    }
    if (!sample.prompt || typeof sample.prompt !== 'string') {
      throw new Error(`samples[${i}] (${sample.sample_id}) missing or invalid required field: prompt (must be a non-empty string)`);
    }

    // validate optional metadata enums; help users typo-check (`'easy?'` etc).
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

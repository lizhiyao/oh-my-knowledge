/**
 * Gold dataset loader and validator.
 *
 * The "gold" file is a YAML document containing human (or stronger-model)
 * annotations for a fixed set of sample_ids. omk loads it and compares the
 * annotations against the judge's scores from a finished evaluation report
 * to compute α / κ / Pearson agreement (see ./human-gold.ts).
 *
 * Schema is deliberately small:
 *
 *   metadata:
 *     annotator: <model id or person identifier>     # required, used for contamination check
 *     annotatedAt: <YYYY-MM-DD>                       # required
 *     version: <string>                               # required
 *     scale: { min: 1, max: 5 }                       # optional, default {1,5}
 *     notes: <free text>                              # optional
 *
 *   annotations:
 *     - sample_id: <must match a sample_id in the eval samples file>
 *       score: <number on the scale>                  # required
 *       reason: <free text>                           # optional, kept for audit only
 *
 * v0.21 supports single-score gold only. Multi-dimensional gold (per-rubric
 * scores) is a candidate for v0.22 once we have real users asking for it —
 * the schema is forwards-compatible (we can add a `dimensions` field next to
 * `score` later without breaking existing files).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import yaml from 'js-yaml';
import { parseYaml } from '../inputs/load-samples.js';

export interface GoldMetadata {
  /** Identifier of who/what produced the annotations — model id, person handle, or team name. */
  annotator: string;
  annotatedAt: string;
  version: string;
  scale?: { min: number; max: number };
  notes?: string;
}

export interface GoldAnnotation {
  sample_id: string;
  score: number;
  reason?: string;
}

export interface GoldDataset {
  metadata: GoldMetadata;
  annotations: GoldAnnotation[];
  /** Source file paths — surfaced for diagnostics (e.g. error messages). */
  sourcePaths: string[];
}

export interface ValidationIssue {
  /** File the issue came from — empty when issue is structural (e.g. missing metadata). */
  path: string;
  /** Annotation index within the file, when applicable. */
  index?: number;
  message: string;
}

export interface LoadResult {
  dataset?: GoldDataset;
  issues: ValidationIssue[];
}

/**
 * Load a gold dataset from a directory.
 *
 * Convention: the directory contains exactly one `metadata.yaml` and one or
 * more `*.yaml` annotation files. Annotation files may declare top-level
 * `annotations: [...]` — multiple files are concatenated. This shape lets
 * users split annotations by topic (code.yaml, writing.yaml, ...) without
 * fighting one giant file in code review.
 */
export function loadGoldDataset(dir: string): LoadResult {
  const issues: ValidationIssue[] = [];
  const absDir = resolve(dir);

  let entries: string[];
  try {
    entries = readdirSync(absDir);
  } catch (err) {
    issues.push({
      path: absDir,
      message: `gold dataset directory not found or unreadable: ${(err as Error).message}`,
    });
    return { issues };
  }

  const yamlFiles = entries.filter((f) => f.endsWith('.yaml') || f.endsWith('.yml')).sort();
  if (yamlFiles.length === 0) {
    issues.push({ path: absDir, message: 'no .yaml files found in gold dataset directory' });
    return { issues };
  }

  let metadata: GoldMetadata | undefined;
  const annotations: GoldAnnotation[] = [];
  const sourcePaths: string[] = [];
  const seenIds = new Set<string>();

  for (const fname of yamlFiles) {
    const fpath = join(absDir, fname);
    sourcePaths.push(fpath);
    let parsed: unknown;
    try {
      parsed = parseYaml(readFileSync(fpath, 'utf-8'));
    } catch (err) {
      issues.push({ path: fpath, message: (err as Error).message });
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      issues.push({ path: fpath, message: 'top-level YAML must be an object' });
      continue;
    }
    const obj = parsed as Record<string, unknown>;

    if (obj.metadata) {
      const metaIssue = validateMetadata(obj.metadata, fpath);
      if (metaIssue) issues.push(metaIssue);
      else if (metadata) {
        issues.push({ path: fpath, message: 'metadata declared in multiple files; keep it in one place' });
      } else {
        metadata = obj.metadata as GoldMetadata;
      }
    }

    if (Array.isArray(obj.annotations)) {
      for (const [i, raw] of (obj.annotations as unknown[]).entries()) {
        const annoIssue = validateAnnotation(raw, fpath, i);
        if (annoIssue) {
          issues.push(annoIssue);
          continue;
        }
        const anno = raw as GoldAnnotation;
        if (seenIds.has(anno.sample_id)) {
          issues.push({
            path: fpath,
            index: i,
            message: `duplicate sample_id "${anno.sample_id}" — each gold annotation must be unique`,
          });
          continue;
        }
        seenIds.add(anno.sample_id);
        annotations.push(anno);
      }
    }
  }

  if (!metadata) {
    issues.push({ path: absDir, message: 'no metadata block found in any file (need annotator/annotatedAt/version)' });
  }
  if (annotations.length === 0) {
    issues.push({ path: absDir, message: 'no annotations found' });
  }

  if (!metadata || annotations.length === 0) {
    return { issues };
  }

  return {
    dataset: { metadata, annotations, sourcePaths },
    issues,
  };
}

function validateMetadata(raw: unknown, path: string): ValidationIssue | null {
  if (typeof raw !== 'object' || raw === null) {
    return { path, message: 'metadata must be an object' };
  }
  const m = raw as Record<string, unknown>;
  for (const k of ['annotator', 'annotatedAt', 'version']) {
    if (typeof m[k] !== 'string' || !m[k]) {
      return { path, message: `metadata.${k} is required and must be a non-empty string` };
    }
  }
  if (m.scale !== undefined) {
    const s = m.scale as Record<string, unknown>;
    if (typeof s !== 'object' || typeof s.min !== 'number' || typeof s.max !== 'number' || (s.max as number) <= (s.min as number)) {
      return { path, message: 'metadata.scale must be { min: number, max: number } with max > min' };
    }
  }
  return null;
}

function validateAnnotation(raw: unknown, path: string, index: number): ValidationIssue | null {
  if (typeof raw !== 'object' || raw === null) {
    return { path, index, message: 'annotation must be an object' };
  }
  const a = raw as Record<string, unknown>;
  if (typeof a.sample_id !== 'string' || !a.sample_id) {
    return { path, index, message: 'sample_id is required and must be a non-empty string' };
  }
  if (typeof a.score !== 'number' || !Number.isFinite(a.score)) {
    return { path, index, message: 'score is required and must be a finite number' };
  }
  return null;
}

/** Re-export YAML serializer so the `gold init` CLI can write a template. */
export function dumpYaml(value: unknown): string {
  return yaml.dump(value, { lineWidth: 100, noRefs: true });
}

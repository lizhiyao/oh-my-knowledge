import {
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';
import type { Sample } from '../types/index.js';
import { withFileLock } from '../shared/file-lock.js';
import { ownRecordValue } from '../shared/record-count.js';
import { parseYaml, validateSamples, type LoadSamplesResult } from './load-samples.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isYamlPath(filePath: string): boolean {
  return /\.(ya?ml)$/i.test(filePath);
}

export function parseSampleDocument(filePath: string): unknown {
  const raw = readFileSync(filePath, 'utf-8');
  return isYamlPath(filePath) ? parseYaml(raw) : JSON.parse(raw);
}

export function getSamplesArray(document: unknown, filePath: string): Sample[] {
  if (Array.isArray(document)) return document as Sample[];
  if (isRecord(document) && Array.isArray(document.samples)) {
    return document.samples as Sample[];
  }
  throw new Error(
    `invalid samples file shape: ${filePath} `
    + `(expected an array or an object with a 'samples' field)`,
  );
}

export function stringifySampleDocument(filePath: string, document: unknown): string {
  if (isYamlPath(filePath)) {
    return yaml.dump(document, { lineWidth: -1, noRefs: true });
  }
  return JSON.stringify(document, null, 2);
}

function writableFilePath(filePath: string): string {
  return lstatSync(filePath).isSymbolicLink() ? realpathSync(filePath) : filePath;
}

function atomicWriteFile(filePath: string, content: string): void {
  const targetPath = writableFilePath(filePath);
  const tempPath = join(
    dirname(targetPath),
    `.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    writeFileSync(tempPath, content, { mode: statSync(targetPath).mode & 0o777 });
    renameSync(tempPath, targetPath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // The rename may already have consumed the temporary file.
    }
    throw error;
  }
}

/**
 * Persist only changed samples back to the source file that originally owned each
 * sample_id. JSON/YAML and array/wrapper shapes are retained, including `requires`
 * and any other wrapper metadata.
 */
export function writeFixedSamplesToSources(
  loaded: Pick<LoadSamplesResult, 'sourceFiles' | 'sampleSourceById'>,
  samples: Sample[],
  changedIds: ReadonlySet<string>,
): string[] {
  if (changedIds.size === 0) return [];

  const fixedById = new Map(samples.map((sample) => [sample.sample_id, sample]));
  const idsByFile = new Map<string, Set<string>>();
  for (const sampleId of changedIds) {
    const filePath = ownRecordValue(loaded.sampleSourceById, sampleId);
    if (!filePath) throw new Error(`sample ${sampleId} source file not found`);
    if (!loaded.sourceFiles.includes(filePath)) {
      throw new Error(`sample ${sampleId} source file is outside the loaded sample set`);
    }
    if (!fixedById.has(sampleId)) {
      throw new Error(`fixed sample ${sampleId} is missing from the update set`);
    }
    const ids = idsByFile.get(filePath) ?? new Set<string>();
    ids.add(sampleId);
    idsByFile.set(filePath, ids);
  }

  for (const [filePath, ids] of idsByFile.entries()) {
    const targetPath = writableFilePath(filePath);
    withFileLock(`${targetPath}.omk.lock`, () => {
      const document = parseSampleDocument(filePath);
      const fileSamples = getSamplesArray(document, filePath);
      const existingIds = new Set(fileSamples.map((sample) => sample.sample_id));
      for (const sampleId of ids) {
        if (!existingIds.has(sampleId)) {
          throw new Error(`sample ${sampleId} is no longer present in ${filePath}`);
        }
      }
      const nextSamples = fileSamples.map((sample) => (
        ids.has(sample.sample_id) ? fixedById.get(sample.sample_id)! : sample
      ));
      validateSamples(nextSamples);
      const nextDocument = Array.isArray(document)
        ? nextSamples
        : { ...(document as Record<string, unknown>), samples: nextSamples };
      atomicWriteFile(filePath, stringifySampleDocument(filePath, nextDocument));
    });
  }
  return [...idsByFile.keys()];
}

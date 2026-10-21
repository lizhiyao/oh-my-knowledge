import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { EXTRACTION_STUDY_INSPECTION_MAX_BYTES } from '../extraction/study-capacity.js';
import { ExtractionStudyBodyError, ExtractionStudyFileError, type ExtractionStudyFileLabel } from './study-inspection-errors.js';

export interface ExtractionStudyInspectionFiles {
  evidence: string; authorReceipt?: string; referenceReceipt?: string; outputReceipt?: string; judgeReceipt?: string;
}

/** Only the CLI constructs this request variant. Portable HTTP JSON cannot select local files. */
export function readExtractionStudyInspectionFiles(files: ExtractionStudyInspectionFiles) {
  let consumed = 0;
  const file = (path: string, label: ExtractionStudyFileLabel): unknown => {
    let fd: number | undefined;
    try {
      const stat = lstatSync(path), remaining = EXTRACTION_STUDY_INSPECTION_MAX_BYTES - consumed;
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > remaining) throw new Error();
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size) throw new Error();
      const bytes = Buffer.allocUnsafe(stat.size + 1); let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!count) break; offset += count;
      }
      if (offset !== stat.size || fstatSync(fd).size !== stat.size) throw new Error();
      const raw = bytes.subarray(0, offset), text = raw.toString('utf8');
      if (!Buffer.from(text).equals(raw)) throw new Error();
      consumed += raw.length; return JSON.parse(text) as unknown;
    } catch { throw new ExtractionStudyFileError(label); }
    finally { if (fd !== undefined) closeSync(fd); }
  };
  return { evidence: file(files.evidence, '--evidence'),
    ...(files.authorReceipt === undefined ? {} : { authorReceipt: file(files.authorReceipt, '--author-review') }),
    ...(files.referenceReceipt === undefined ? {} : { referenceReceipt: file(files.referenceReceipt, '--reference-review') }),
    ...(files.outputReceipt === undefined ? {} : { outputReceipt: file(files.outputReceipt, '--output-review') }),
    ...(files.judgeReceipt === undefined ? {} : { judgeReceipt: file(files.judgeReceipt, '--judge-review') }) };
}

/** Match the HTTP JSON-object grammar; parsing stays inside the inspection worker. */
export function parseExtractionStudyInspectionBody(bytes: Uint8Array): Record<string, unknown> {
  let parsed: unknown;
  try { const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8').trim(); parsed = text ? JSON.parse(text) : {}; }
  catch { throw new ExtractionStudyBodyError('invalid_json_body'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ExtractionStudyBodyError('json_body_not_object');
  return parsed as Record<string, unknown>;
}

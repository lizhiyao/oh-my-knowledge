import { accessSync, constants, readFileSync, writeFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { withFileLock } from '../../shared/file-lock.js';
import { getSamplesArray, parseSampleDocument, stringifySampleDocument } from './sample-document.js';
import type { Sample as SampleType, EvalSampleSetDocument } from './contracts/sample.js';

/** Reject known invalid or unwritable targets before any model invocation. */
export function preflightSampleAppend(file: string): string {
  const snapshot = readFileSync(file, 'utf8');
  getSamplesArray(parseSampleDocument(file), file);
  accessSync(file, constants.W_OK);
  accessSync(dirname(file), constants.W_OK);
  return snapshot;
}

/** --append 合并:已有用例原样保留,新用例逐条接在后面;sample_id 撞已有(或本批已用)时
 *  自动加 `-2`/`-3` 后缀去重。模型每次从 s001 重编号,撞 id 不代表内容重复,所以是改名保留
 *  而非丢弃(不做内容级去重)。`reserved` 为额外要避开的 id 集(目录模式跨同目录其它 sample
 *  文件去重用,见 collectDirSampleIds)。 */
export function mergeAppendSamples(
  existing: SampleType[],
  fresh: SampleType[],
  reserved?: ReadonlySet<string>,
): SampleType[] {
  const used = new Set(existing.map((s) => s.sample_id));
  if (reserved) for (const id of reserved) used.add(id);
  const merged: SampleType[] = [...existing];
  for (const sample of fresh) {
    let id = sample.sample_id;
    if (used.has(id)) {
      let n = 2;
      while (used.has(`${id}-${n}`)) n += 1;
      id = `${id}-${n}`;
    }
    used.add(id);
    merged.push(id === sample.sample_id ? sample : { ...sample, sample_id: id });
  }
  return merged;
}


/** Commit a validated merge atomically; never replace a document changed during generation. */
export function appendSamplesToFile(
  file: string,
  fresh: SampleType[],
  reserved?: ReadonlySet<string>,
  expected?: string,
): number {
  return withFileLock(`${file}.lock`, () => {
    const snapshot = preflightSampleAppend(file);
    if (expected !== undefined && snapshot !== expected) {
      throw new Error(`Samples changed during generation; retry append: ${file}`);
    }
    const doc = parseSampleDocument(file) as EvalSampleSetDocument;
    const merged = mergeAppendSamples(getSamplesArray(doc, file), fresh, reserved);
    const next = { ...doc, samples: merged };
    getSamplesArray(next, file);
    const temporary = join(dirname(file), `.omk-samples-${randomUUID()}`);
    try {
      writeFileSync(temporary, stringifySampleDocument(file, next), { flag: 'wx', mode: statSync(file).mode & 0o777 });
      if (readFileSync(file, 'utf8') !== snapshot) {
        throw new Error(`Samples changed during append; retry: ${file}`);
      }
      renameSync(temporary, file);
    } finally {
      rmSync(temporary, { force: true });
    }
    return merged.length;
  });
}

import { existsSync, readFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import type { generateSamples } from './generator.js';
import { loadSamples, listSampleFilesInDir } from '../inputs/load-samples.js';
import { findCanonicalSamplesFile } from '../inputs/sample-locator.js';
import { getSamplesArray, parseSampleDocument } from '../inputs/sample-document.js';
import { appendSamplesToFile, preflightSampleAppend } from '../inputs/append-samples.js';
import { createEvalSampleSetDocument } from '../inputs/schemas/sample-set.js';
import { createJsonFileAtomic } from '../../shared/atomic-json.js';

type Generator = typeof generateSamples;
type GenerationOptions = Omit<Parameters<Generator>[0], 'skillContent'>;

export class SamplePreparationError extends Error {
  constructor(
    readonly reason: 'exists' | 'missing' | 'invalid' | 'empty' | 'generated-empty',
    readonly path: string,
    cause?: unknown,
  ) {
    super(`Sample preparation failed (${reason}): ${path}`, { cause });
    this.name = 'SamplePreparationError';
  }
}

interface GenerateSkillSamplesInput {
  readonly skillPath: string;
  readonly samplesPath: string;
  readonly options: GenerationOptions;
  readonly append?: boolean;
  readonly requireSamples?: boolean;
  readonly onGenerating?: (path: string) => void;
}

/** 路径处是否已存在「用例源」:按 statSync 判型 —— 文件(含无扩展名)直接算存在;
 *  目录看是否含候选用例文件(排除 report/health/_ 前缀,对齐 sample.ts 的发现约定)。
 *  用于区分「损坏文件(存在但解析失败 → 报错不覆盖)」与「确实没有用例(可生成)」。
 *  不能用 extname 猜文件/目录:无扩展名的损坏样本文件会绕过守卫被覆盖,
 *  带点的目录名(如 samples.v2/)会被误当文件。 */
export function sampleSourceExists(p: string): boolean {
  let st;
  try { st = statSync(p); } catch { return false; }
  if (!st.isDirectory()) return true;
  try {
    return readdirSync(p).some((f) => /\.(json|ya?ml)$/i.test(f) && !/^(report|health|_)/i.test(f));
  } catch { return false; }
}

/** 自动生成时的落盘目标:已存在的目录(含带点目录名,如 samples.v2/)→ 写进目录内的
 *  eval-samples.json;已存在的文件 → 返回该路径(加载校验会拒绝空或损坏文档);不存在 → 按扩展名(有扩展名当文件,无扩展名
 *  当目录,落 eval-samples.json)。与 sampleSourceExists 同用 statSync 判型,不被带点目录名
 *  误当成文件(否则 writeFileSync 撞 EISDIR)。 */
export function resolveSampleOutFile(samplesAbs: string): string {
  try {
    return statSync(samplesAbs).isDirectory() ? join(samplesAbs, 'eval-samples.json') : samplesAbs;
  } catch {
    return extname(samplesAbs) ? samplesAbs : join(samplesAbs, 'eval-samples.json');
  }
}

/** 目录模式 append:收集目录内所有 sample 文件的 sample_id,跨文件去重用 —— eval 走目录模式
 *  会把目录下所有文件合并加载,跨文件撞 id 直接报错(load-samples 的 duplicate sample_id)。
 *  复用 listSampleFilesInDir 的排序/过滤口径;best-effort:解析失败的文件跳过。 */
function collectDirSampleIds(dir: string): Set<string> {
  const ids = new Set<string>();
  let files: string[];
  try { files = listSampleFilesInDir(dir); } catch { return ids; }
  for (const f of files) {
    const full = join(dir, f);
    try {
      for (const s of getSamplesArray(parseSampleDocument(full), full)) {
        if (typeof s.sample_id === 'string') ids.add(s.sample_id);
      }
    } catch { /* skip unparseable / 非 sample 文件 */ }
  }
  return ids;
}


/** Generate and persist one sample set; all hosts share preflight and commit rules. */
export async function generateSkillSamples(input: GenerateSkillSamplesInput, generate?: Generator) {
  const { skillPath, samplesPath, options, append, onGenerating } = input;
  options.signal?.throwIfAborted();
  const directory = existsSync(samplesPath) ? statSync(samplesPath).isDirectory() : !extname(samplesPath);
  const existing = directory ? findCanonicalSamplesFile(samplesPath) : existsSync(samplesPath) ? samplesPath : null;
  const outputPath = existing ?? (directory ? join(samplesPath, 'eval-samples.json') : samplesPath);
  if (existing && !append) throw new SamplePreparationError('exists', existing);
  const snapshot = existing ? preflightSampleAppend(existing) : undefined;
  const skillContent = readFileSync(skillPath, 'utf8');
  onGenerating?.(outputPath);
  const generator = generate ?? (await import('./generator.js')).generateSamples;
  const { samples, costUSD } = await generator({ ...options, skillContent });
  options.signal?.throwIfAborted();
  if (input.requireSamples && samples.length === 0) throw new SamplePreparationError('generated-empty', outputPath);
  let total = samples.length;
  if (existing) {
    const reserved = directory ? collectDirSampleIds(samplesPath) : undefined;
    total = appendSamplesToFile(existing, samples, reserved, snapshot);
  } else {
    mkdirSync(dirname(outputPath), { recursive: true });
    createJsonFileAtomic(outputPath, createEvalSampleSetDocument(samples));
  }
  return { outputPath, added: samples.length, total, costUSD, appended: Boolean(existing) };
}

/** Existing or explicitly selected sources are never replaced by auto-generation. */
export async function ensureSkillSamples(
  input: GenerateSkillSamplesInput & { readonly explicit: boolean },
  generate?: Generator,
) {
  const { samplesPath, explicit } = input;
  input.options.signal?.throwIfAborted();
  if (explicit && !existsSync(samplesPath)) throw new SamplePreparationError('missing', samplesPath);
  let hasSamples = false;
  try {
    hasSamples = loadSamples(samplesPath).samples.length > 0;
  } catch (error) {
    if (sampleSourceExists(samplesPath)) throw new SamplePreparationError('invalid', samplesPath, error);
  }
  if (hasSamples) return { status: 'existing' as const };
  if (explicit) throw new SamplePreparationError('empty', samplesPath);
  const result = await generateSkillSamples({ ...input, samplesPath: resolveSampleOutFile(samplesPath), append: false, requireSamples: true }, generate);
  return { status: 'generated' as const, ...result };
}

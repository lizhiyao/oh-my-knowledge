/**
 * Hedging classifier (spec §四.3, v0.2).
 *
 * regex 召回 → LLM 二次判定。把 extractHedgingSignals 的 candidate 句子送给小模型,
 * 让模型判断"这一句是知识层面的不确定,还是业务推理 / 假设 / 礼貌表达"。
 *
 * 关键约束:
 *   - cost 上限: 默认 maxCandidates=50, 超出截断 + warn
 *   - cache: in-memory Map<sha256(sentence), HedgingVerdict>, 同句子不重复调用
 *   - 失败降级: 调用 / 解析失败 → 该 candidate 默认 isUncertainty=true (保守保留)
 */

import { createHash } from 'node:crypto';

import type { ExecutorFn, HedgingVerdict } from '../types.js';

export interface HedgingCandidate {
  sampleId: string;
  sentence: string;
  context: string;
}

export interface ClassifyOptions {
  maxCandidates?: number;
  model?: string;
  batchSize?: number;
}

export interface ClassifyResult {
  verdicts: HedgingVerdict[];
  costUSD: number;
  truncated: boolean;
}

const DEFAULT_MAX_CANDIDATES = 50;
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

// in-memory cache,进程内复用。key = sha256(sentence)。
const verdictCache = new Map<string, HedgingVerdict>();

export function clearHedgingCache(): void {
  verdictCache.clear();
}

function hashSentence(sentence: string): string {
  return createHash('sha256').update(sentence).digest('hex').slice(0, 16);
}

function buildBatchPrompt(batch: HedgingCandidate[]): string {
  const items = batch
    .map((c, i) => `### ${i + 1}\n命中句: ${c.sentence}\n上下文: ${c.context}`)
    .join('\n\n');
  return [
    '判断以下每段话是否表达了"知识 / 事实层面的不确定"。',
    '',
    '满足以下任一条算"不确定"(isUncertainty=true):',
    '  - 表示自己不知道答案 / 缺少信息 / 需要查证',
    '  - 给出答案但显著降级措辞("可能是 X 但不确定")',
    '',
    '以下情况 **不算** "不确定" (isUncertainty=false):',
    '  - 业务可能性分析(讨论多种业务场景的可能性)',
    '  - 礼貌 / 假设性措辞("如果你需要,可能可以...")',
    '  - 对未来不确定("未来可能会..."),不属于知识不确定',
    '',
    items,
    '',
    '返回 JSON 数组(不要 markdown 代码块标记),按上面编号顺序,每项格式:',
    '{"id": <编号>, "isUncertainty": <bool>, "confidence": <0-1 的小数>, "reason": "<10 字以内简短理由>"}',
  ].join('\n');
}

interface ParsedItem {
  id?: number;
  isUncertainty?: boolean;
  confidence?: number;
  reason?: string;
}

function parseBatchResponse(text: string, batchSize: number): HedgingVerdict[] {
  const trimmed = text.trim();
  const jsonMatch = trimmed.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error(`classifier returned non-JSON: ${trimmed.slice(0, 100)}`);
  const parsed = JSON.parse(jsonMatch[0]) as ParsedItem[];
  if (!Array.isArray(parsed)) throw new Error('classifier response is not an array');
  // 按 id 排序后填充,缺失的 id 走降级
  const verdicts: HedgingVerdict[] = [];
  for (let i = 1; i <= batchSize; i++) {
    const item = parsed.find((p) => Number(p.id) === i);
    if (!item) {
      verdicts.push({ isUncertainty: true, confidence: 0, reason: `classifier missing id ${i}` });
      continue;
    }
    verdicts.push({
      isUncertainty: Boolean(item.isUncertainty),
      confidence: Math.max(0, Math.min(1, Number(item.confidence) || 0)),
      reason: String(item.reason || '').slice(0, 60),
    });
  }
  return verdicts;
}

function fallbackVerdict(reason: string): HedgingVerdict {
  return { isUncertainty: true, confidence: 0, reason: `classifier failed: ${reason}` };
}

/**
 * 对一批 candidate 做分类判定。返回与 input 等长的 verdicts。
 * 失败降级:单批 LLM 调用 / 解析失败 → 该 batch 全部 isUncertainty=true (保守保留)。
 */
export async function classifyHedgingCandidates(
  candidates: HedgingCandidate[],
  executor: ExecutorFn,
  opts?: ClassifyOptions,
): Promise<ClassifyResult> {
  const max = opts?.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const batchSize = opts?.batchSize ?? DEFAULT_BATCH_SIZE;
  const model = opts?.model ?? DEFAULT_MODEL;
  const truncated = candidates.length > max;
  const work = candidates.slice(0, max);
  const verdicts: HedgingVerdict[] = new Array(candidates.length);
  let costUSD = 0;

  if (truncated) {
    process.stderr.write(`[omk] hedging classifier: ${candidates.length} candidates exceeds maxCandidates=${max}, truncated\n`);
    // 被截断的部分走降级保守保留
    for (let i = max; i < candidates.length; i++) {
      verdicts[i] = fallbackVerdict('truncated by maxCandidates');
    }
  }

  // 先查 cache
  const uncached: { idx: number; cand: HedgingCandidate }[] = [];
  for (let i = 0; i < work.length; i++) {
    const key = hashSentence(work[i].sentence);
    const hit = verdictCache.get(key);
    if (hit) {
      verdicts[i] = hit;
    } else {
      uncached.push({ idx: i, cand: work[i] });
    }
  }

  // 按 batch 调用
  for (let b = 0; b < uncached.length; b += batchSize) {
    const slice = uncached.slice(b, b + batchSize);
    const batchCands = slice.map((s) => s.cand);
    const prompt = buildBatchPrompt(batchCands);
    let result;
    try {
      result = await executor({
        model,
        system: '你是一个判定 LLM 输出是否表达"知识层面不确定"的分类器。只返回 JSON 数组。',
        prompt,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      slice.forEach((s) => { verdicts[s.idx] = fallbackVerdict(`exec ${msg}`); });
      continue;
    }
    if (!result.ok || !result.output) {
      slice.forEach((s) => { verdicts[s.idx] = fallbackVerdict(`exec ${result.error ?? 'no output'}`); });
      costUSD += result.costUSD ?? 0;
      continue;
    }
    costUSD += result.costUSD ?? 0;
    let parsed: HedgingVerdict[];
    try {
      parsed = parseBatchResponse(result.output, slice.length);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      slice.forEach((s) => { verdicts[s.idx] = fallbackVerdict(`parse ${msg}`); });
      continue;
    }
    slice.forEach((s, i) => {
      verdicts[s.idx] = parsed[i];
      verdictCache.set(hashSentence(s.cand.sentence), parsed[i]);
    });
  }

  return { verdicts, costUSD, truncated };
}

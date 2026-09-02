/**
 * `--judge-models` CLI 参数解析。
 *
 * 输入格式: `executor:model[,executor:model,...]`
 *   - 1 entry = 单评委
 *   - ≥ 2 entry = ensemble(是否接受由调用方决定)
 *
 * 校验语义:
 *   - 空字符串 / 全空 entry 抛错(避免 silent default)
 *   - entry 必须是 `executor:model`,缺一报错
 *   - 重复 `executor:model` 拒绝 —— ensemble 聚合用 `Map<judgeId, scores>` 会把
 *     同 id 合并,N 不可信、agreement 失真;而 grading 阶段又会按 entry 数实际跑
 *     N 次,产生「跑了但聚合不到」的隐藏成本
 *
 * 两个公开符号:
 *   - `parseJudgeModelsArg`: 纯函数,throw Error,供单测断言文案
 *   - `parseJudgeModelsArgOrExit`: CLI 友好封装,catch 后 stderr + CliExit(2),
 *     给 `eval` / `evolve` 子命令共用(exit 2 = parser/参数错误,区别于
 *     doctor / gate eval failure 的 exit 1)
 */

import { CliExit } from '../cli-exit.js';
import type { JudgeConfig } from '../../../eval-workflows/grading/contracts/config.js';

export function parseJudgeModelsArg(raw: string): JudgeConfig[] {
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) {
    throw new Error(`--judge-models cannot be empty`);
  }
  const result: JudgeConfig[] = [];
  const seen = new Set<string>();
  for (const p of parts) {
    const idx = p.indexOf(':');
    if (idx <= 0 || idx === p.length - 1) {
      throw new Error(`--judge-models entry must be 'executor:model' (got "${p}")`);
    }
    const executor = p.slice(0, idx);
    const model = p.slice(idx + 1);
    const key = `${executor}:${model}`;
    if (seen.has(key)) {
      throw new Error(`--judge-models has duplicate entry "${key}"; ensemble 聚合按 executor:model 去重,重复条目会让 N 不可信、agreement 失真`);
    }
    seen.add(key);
    result.push({ executor, model });
  }
  return result;
}

export function parseJudgeModelsArgOrExit(raw: string): JudgeConfig[] {
  try {
    return parseJudgeModelsArg(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`error: ${msg}`);
    throw new CliExit(2);
  }
}

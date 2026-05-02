/**
 * parseArgs strict:true wrapper, catch unknown option throw 转友好 stderr + exit 2。
 *
 * 收口理由: parseArgs strict:false 让未声明的 flag 被静默吞掉, 用户写错 flag
 * 名 (或传已删除 flag) 时命令 exit 0 但什么都没生效, 比 fail 还危险。所有
 * 子命令统一走这层, "未知就报错" 一致语义。
 *
 * exit 2 区分于业务 failure 的 exit 1 (doctor / gate / verdict 等), CI 可分别处理。
 *
 * 类型 cast: strict:true 模式下 parseArgs 返回 values 含 array possible (因为
 * options 可声明 multiple)。omk 现有 options 都不用 multiple, 直接 cast 收回
 * 简单类型, caller 解构干净。后续若用 multiple 需要放宽这个 cast。
 */

import { parseArgs } from 'node:util';
import type { ParseArgsConfig } from 'node:util';

export interface StrictParsedArgs {
  values: Record<string, string | boolean | undefined>;
  positionals: string[];
}

export function parseArgsStrictOrExit(opts: Omit<ParseArgsConfig, 'strict'>): StrictParsedArgs {
  try {
    const result = parseArgs({ ...opts, strict: true });
    return result as unknown as StrictParsedArgs;
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
}

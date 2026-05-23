import { execute } from '@oclif/core';

// oclif dispatcher 入口。从 dist/cli/oclif/ 这个文件位置出发,oclif 用 package.json
// oclif.commands(./dist/cli/commands)找到所有 Command 类。helpClass 也走
// package.json 字段。
//
// 注意 dir: import.meta.url 必须传 — oclif 用它确定 package.json 跟 commands
// dir 的相对位置。

export async function runOclifPath(): Promise<void> {
  await execute({ dir: import.meta.url });
}

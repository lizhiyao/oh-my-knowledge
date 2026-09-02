'use strict';

// build-time asset copy: src/ 下的非 .ts 资产(mock-hook.cjs / runtime prompt md)
// 以及仓库内置 agent skill。
// tsc 不会自动复制非 .ts 文件。把每个 asset 复制到 dist/ 下对应路径,
// 让运行时 sibling-relative 解析(dirname(import.meta.url) + sibling 文件)
// 在 dev(src/)和 npm 安装(dist/)两种位置都能拿到 asset。

const fs = require('node:fs');
const path = require('node:path');

const ASSETS = [
  ['src/executors/mock-runtime/mock-hook.cjs', 'dist/executors/mock-runtime/mock-hook.cjs'],
  ['src/observability/prompts/llm-enhanced-review.prompt.md', 'dist/observability/prompts/llm-enhanced-review.prompt.md'],
  ['src/dsh-plugin/cordis.patch.yml', 'dist/dsh-plugin/cordis.patch.yml'],
];

for (const [src, dst] of ASSETS) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

const DIR_ASSETS = [
  ['.agents/skills/omk', 'dist/assets/agent-skills/omk'],
  ['schemas/eval-core/v1', 'dist/eval-core/contracts/schemas/v1'],
  ['schemas/eval-samples/v1', 'dist/eval-workflows/inputs/contracts/schemas/v1'],
];

for (const [src, dst] of DIR_ASSETS) {
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
}

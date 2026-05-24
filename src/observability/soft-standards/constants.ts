import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// sibling 模式:dev 下 import.meta.url 指 src/observability/soft-standards/constants.ts,
// npm 安装下指 dist/observability/soft-standards/constants.js,
// 两边的 ../prompts/ 都对得上(build script 把 prompt md 同步复制到 dist/observability/prompts/)。
export const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts');

export const SOFT_STANDARD_PROMPT_ID = 'llm-enhanced-review';
export const SOFT_STANDARD_PROMPT_VERSION = '2026-05-22.v7';
export const DEFAULT_LLM_ENHANCED_REVIEW_MODEL = 'sonnet';

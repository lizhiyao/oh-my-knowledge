import { createHash } from 'node:crypto';
import {
  getJudgePromptHash,
  getRagJudgePromptHash,
  getSemanticPromptHash,
} from '../../src/eval-workflows/instruments/prompts/judge-prompts.js';
import { readPromptDocument } from '../../src/observability/prompts/document.js';
import {
  PROMPTS_DIR,
  SOFT_STANDARD_PROMPT_ID,
  SOFT_STANDARD_PROMPT_VERSION,
} from '../../src/observability/soft-standards/constants.js';
import { EXTRACTION_PROMPT } from '../../src/knowledge/extraction/prompt.js';
import { STRICT_EXTRACTION_PROMPT } from '../../src/knowledge/extraction/strict-prompt.js';
import { EXTRACTION_FEEDBACK_PREAMBLE } from '../../src/knowledge/extraction/generation-policy.js';
import { ENTITY_LINK_PROMPT_HASH } from '../../src/knowledge/entity-linking/entity-link-prompt.js';

/**
 * omk 所有 LLM prompt 的单一编目 —— 发现入口 + 测量学冻结入口。
 *
 * 解决「prompt 散在多个目录、难管理」与「只有 2 个 prompt 被冻结」两个问题:
 *   - 每条登记 prompt 的位置(module)+ 用途,一处可查全。
 *   - measurementInvariant 为 true 的(影响分数或测量产物可比性的 prompt)带 getHash,
 *     由 test/measurement-governance/prompt-registry-freeze.test.ts 统一冻结,文本漂移即 CI 红。
 *
 * 注意:hash 形状按各自历史口径,不强行统一 ——
 *   - rubric 评委:12 位(getJudgePromptHash,持久化进 report.meta.judgePromptHash 的同口径);
 *   - RAG / semantic:12 位(getRagJudgePromptHash / getSemanticPromptHash,仅供冻结 drift 检测);
 *   - observe 复盘:64 位(readPromptDocument 读 .md 全文 sha256);
 *   - knowledge extraction:64 位(EXTRACTION_PROMPT 原始 UTF-8 sha256,非运行时规范化 JSON hash)。
 *   - entity link proposal:64 位(system 原始 UTF-8 sha256,包含唯一响应 Schema 的派生文本)。
 * 用限定名 `promptId`(非裸 `kind`,见 terminology-spec §5.4)。
 */
export interface PromptRegistryEntry {
  /** 稳定标识(冻结表的 key)。 */
  promptId: string;
  /** 人类可读用途。 */
  purpose: string;
  /** 定义位置(发现用,相对仓库根的源文件路径)。 */
  module: string;
  /** 是否影响分数或测量产物可比性 → 须冻结防漂移。 */
  measurementInvariant: boolean;
  /** 仅 measurementInvariant 条目提供:当前 prompt 的 hash。 */
  getHash?: () => string;
}

export const PROMPT_REGISTRY: PromptRegistryEntry[] = [
  // —— 测量学不变量:影响分数或测量产物可比性的 prompt,统一冻结 ——
  {
    promptId: 'rubric-judge-debias-on',
    purpose: 'rubric 主评委(length-debias 开,默认)',
    module: 'src/eval-workflows/instruments/prompts/judge-prompts.ts',
    measurementInvariant: true,
    getHash: () => getJudgePromptHash(true),
  },
  {
    promptId: 'rubric-judge-debias-off',
    purpose: 'rubric 主评委(--no-debias-length,length-debias 关)',
    module: 'src/eval-workflows/instruments/prompts/judge-prompts.ts',
    measurementInvariant: true,
    getHash: () => getJudgePromptHash(false),
  },
  {
    promptId: 'semantic-similarity',
    purpose: 'semantic_similarity 断言评委',
    module: 'src/eval-workflows/instruments/prompts/judge-prompts.ts',
    measurementInvariant: true,
    getHash: () => getSemanticPromptHash(),
  },
  {
    promptId: 'rag-faithfulness',
    purpose: 'RAG faithfulness(输出是否被 context 支持)',
    module: 'src/eval-workflows/instruments/prompts/judge-prompts.ts',
    measurementInvariant: true,
    getHash: () => getRagJudgePromptHash('faithfulness'),
  },
  {
    promptId: 'rag-answer-relevancy',
    purpose: 'RAG answer_relevancy(是否切题)',
    module: 'src/eval-workflows/instruments/prompts/judge-prompts.ts',
    measurementInvariant: true,
    getHash: () => getRagJudgePromptHash('answer_relevancy'),
  },
  {
    promptId: 'rag-context-recall',
    purpose: 'RAG context_recall(关键事实覆盖率)',
    module: 'src/eval-workflows/instruments/prompts/judge-prompts.ts',
    measurementInvariant: true,
    getHash: () => getRagJudgePromptHash('context_recall'),
  },
  {
    promptId: 'observe-llm-enhanced-review',
    purpose: 'observe 运行期软标准抽取 / LLM 增强复盘',
    module: 'src/observability/prompts/llm-enhanced-review.prompt.md',
    measurementInvariant: true,
    getHash: () => readPromptDocument({
      dir: PROMPTS_DIR,
      fileName: `${SOFT_STANDARD_PROMPT_ID}.prompt.md`,
      id: SOFT_STANDARD_PROMPT_ID,
      version: SOFT_STANDARD_PROMPT_VERSION,
    }).hash,
  },
  {
    promptId: 'knowledge-extraction',
    purpose: '知识与实体提取(输出及其质量测量身份)',
    module: 'src/knowledge/extraction/prompt.ts',
    measurementInvariant: true,
    getHash: () => createHash('sha256').update(EXTRACTION_PROMPT).digest('hex'),
  },
  {
    promptId: 'knowledge-extraction-strict',
    purpose: 'strict 知识与实体提取(含 few-shot 的独立提示词及测量身份)',
    module: 'src/knowledge/extraction/strict-prompt.ts',
    measurementInvariant: true,
    getHash: () => createHash('sha256').update(STRICT_EXTRACTION_PROMPT).digest('hex'),
  },
  {
    promptId: 'knowledge-extraction-feedback',
    purpose: '有限校验重问的宿主反馈指令（knowledge-generation-feedback/v1）',
    module: 'src/knowledge/extraction/generation-policy.ts',
    measurementInvariant: true,
    getHash: () => createHash('sha256').update(EXTRACTION_FEEDBACK_PREAMBLE).digest('hex'),
  },
  {
    promptId: 'entity-link-proposal',
    purpose: '跨窗口实体关联建议(输出及其质量测量身份)',
    module: 'src/knowledge/entity-linking/entity-link-prompt.ts',
    measurementInvariant: true,
    getHash: () => ENTITY_LINK_PROMPT_HASH.slice('sha256:'.length),
  },

  // —— 其它用途:不在当前冻结范围,仅登记供发现 ——
  { promptId: 'hedging-classifier', purpose: 'hedging 判定(喂 gap-signal,非评分)', module: 'src/observability/analysis/hedging-classifier.ts', measurementInvariant: false },
  { promptId: 'sample-generator', purpose: '用例生成(skill / trace → samples)', module: 'src/eval-workflows/sample-generation/generator.ts', measurementInvariant: false },
  { promptId: 'skill-improve', purpose: 'skill 迭代改进(evolve)', module: 'src/knowledge/artifacts/authoring/core-evolver.ts', measurementInvariant: false },
  { promptId: 'doctor-fixer', purpose: 'doctor 健康项修复向导', module: 'src/knowledge/artifacts/doctor/fixer.ts', measurementInvariant: false },
  { promptId: 'skill-health', purpose: 'skill 健康度审计(仅 CLI doctor,不进 eval 评分门禁)', module: 'src/knowledge/artifacts/doctor/health/prompt-builder.ts', measurementInvariant: false },
  { promptId: 'skill-health-merge', purpose: '多采样 finding 同根因归并(doctor 多采样默认 llm 归并)', module: 'src/knowledge/artifacts/doctor/health/merge-prompt.ts', measurementInvariant: false },
];

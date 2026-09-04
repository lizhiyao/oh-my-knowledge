import type { Assertion } from './assertion.js';
import type { Mock } from '../../../executors/contracts/mock.js';

/** sample provenance(数据来源)。`evolved` / `mixed` 留 follow-up
 *  跟 evolver 升级一起做。 */
export type SampleProvenance = 'human' | 'llm-generated' | 'production-trace';

/** sample 难度等级。简单分桶,跟 IRT 风格 fine-grained difficulty 不同。 */
export type SampleDifficulty = 'easy' | 'medium' | 'hard';

/** Sample 可选声明的 skill 结构锚点。用于 Skill Map / 诊断，不参与 grading / judge / verdict。 */
export type SampleCoverageTargetKind =
  | 'skill'
  | 'skill_file'
  | 'frontmatter'
  | 'reference'
  | 'script'
  | 'hard_rule'
  | 'workflow'
  | 'workflow_node';

export interface SampleCoverageTarget {
  /** 目标类型。避免裸 kind，保持 Artifact.kind 语义唯一。 */
  targetKind: SampleCoverageTargetKind;
  /** 稳定引用：路径或 ID。reference/script 用 skill 根相对路径，workflow_node 用 workflowId.nodeId。 */
  ref: string;
}

/** Sample 题设环境声明。仅注入 prompt,不会修改 PATH、物化文件或改变 runtime。 */
export interface SampleEnvironment {
  /** 题设声明可用的 CLI,LLM 不再 which / find / type / command -v 探测。 */
  cli_available?: string[];
  /** 题设声明存在的文件/脚本(支持 ~ / $SKILL_DIR / 绝对路径),LLM 不再 Glob / Read / test -f 探测。
   *  这是 prompt context,不会在 cwd 物化文件;需要真实读取时必须提供 sample.cwd 中的 fixture。 */
  files_available?: string[];
  /** 自由文本兜底,场景特殊说明(如"凭证已配""设备 SN xxx 已租"等)。 */
  notes?: string;
}

export interface SampleRubricCriterion {
  /** 单一、可独立判定的评分准则。 */
  criterion: string;
  /** 当前 sample 内的显式聚合权重；所有 rubric 权重之和必须为 1。 */
  weight: number;
}

export type SampleRubric = Record<string, SampleRubricCriterion>;

export interface Sample {
  sample_id: string;
  prompt: string;
  context?: string;
  cwd?: string;
  rubric?: SampleRubric;
  assertions?: Assertion[];
  allowedTools?: string[];
  /** 该 sample 测试的能力维度,可多维。free-form string,suggested
   *  values 见 docs/specs/sample-design-spec.md。aggregate 时大小写不敏感。
   *  纯文档 / 诊断用,不参与 grading / judge / verdict。 */
  capability?: string[];
  /** 难度分层,enum 防错。纯文档 / 诊断用。 */
  difficulty?: SampleDifficulty;
  /** 该 sample 测的 construct 类型。suggested:`'necessity'`(测必要性,
   *  baseline-vs-skill)/ `'quality'`(测 skill 写得好不好,skill-vs-skill-variant)/
   *  `'capability'`(测某具体能力维度)。free-form string,允许自定义。
   *  纯文档 / 诊断用,不参与 grading。 */
  construct?: string;
  /** 数据来源。`omk sample` 自动注入 `'llm-generated'`,人工
   *  curated 用 `'human'`,production trace 抽样用 `'production-trace'`。
   *  纯文档 / 诊断用。 */
  provenance?: SampleProvenance;
  /** 该 sample 可选声明的 skill 结构锚点。纯文档 / 图谱诊断用，不进入评分、评委或 verdict。 */
  covers?: SampleCoverageTarget[];
  /** 诱错样本(tripwire)标记。true = 此 sample 故意设计成 LLM 应该 fail 的诱导陷阱
   *  (如:用户用错误前提诱导 / 跳步骤 / 用错参数类型),用于测 skill 是否能让 LLM
   *  识破并纠正。Diagnostic 看到 tripwire:true 时会建议"无需改 skill"(rootCause:
   *  tripwire_intentional),避免误导 skill 作者改文档去"修"一个故意的失败。
   *  UI 用户可见文案统一中文叫"诱错样本",字段名保留 tripwire 不变(API 契约)。 */
  tripwire?: boolean;
  /** 评测时拦截的工具调用 + mock 返回值。runtime 在 executor 入口安装 PreToolUse hook。
   *  详见 docs/sample-mocks.md(命中规则、状态机、fixture 文件)。 */
  mocks?: Mock[];
  /** mocks 严格模式。
   *  - true / undefined(default):未命中即 deny(防意外真调外部接口/CLI/MCP/写状态)
   *  - false:显式允许未命中的 tool 调用透传(继续真跑底层)。
   *  部分 mock 探索场景才应显式写 false。 */
  mocksStrict?: boolean;
  /** 题设环境声明,仅作 prompt 上下文。详见 SampleEnvironment。 */
  environment?: SampleEnvironment;
}

export interface EvalSampleSetDocument {
  schemaVersion: 'omk.eval-sample-set/v2';
  requires?: {
    tools?: string[];
    files?: string[];
    env?: string[];
    preflight?: string[];
  };
  samples: Sample[];
}

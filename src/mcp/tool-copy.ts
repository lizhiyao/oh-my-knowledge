import type { Lang } from '../shared/language.js';
import { resolveLanguagePreference } from '../shared/language-preference.js';

/**
 * MCP 面向人展示的工具元数据。`title` 与 `description` 会被宿主 UI 直接显示，
 * 因此必须同语言：此前 title 固定中文、description 固定英文，英文用户拿到的是
 * 中英混排的工具清单。`inputSchema` 里字段级 `.describe()` 属于 schema 契约，
 * 保持单一英文，不随语言变——同一份输入契约出现两种语言的键描述更难对照。
 */
export interface McpDisplayCopy {
  title: string;
  description: string;
}

const COPY: Record<string, Record<Lang, McpDisplayCopy>> = {
  save_observation: {
    zh: {
      title: '保存 OMK 知识反馈',
      description: [
        '仅在用户明确要求保存之后记录知识反馈。',
        '这会捕获提交的反馈与可选证据，落在 OMK 工具边界上。',
        '它不捕获完整客户端会话、其它工具调用或隐藏推理。',
      ].join(' '),
    },
    en: {
      title: 'Save OMK knowledge feedback',
      description: [
        'Record knowledge feedback only after the user explicitly asks to save it.',
        'This captures the submitted feedback and optional evidence at the OMK tool boundary.',
        'It does not capture the full client conversation, other tool calls, or hidden reasoning.',
      ].join(' '),
    },
  },
  get_observation: {
    zh: {
      title: '读取 OMK 知识反馈',
      description: [
        '读取一条已显式捕获的知识反馈、用户授权的证据、部分覆盖情况与当前人工复核状态。',
        '它绝不返回完整客户端记录或隐藏推理。',
      ].join(' '),
    },
    en: {
      title: 'Read OMK knowledge feedback',
      description: [
        'Read one explicitly captured observation, its user-authorized evidence, partial coverage,',
        'and current human review state. This never returns a complete client transcript or hidden reasoning.',
      ].join(' '),
    },
  },
  record_observation_review: {
    zh: {
      title: '保存 OMK 人工复核',
      description: [
        '记录用户或复核人对某条已捕获反馈的结论。',
        '只有在人确认知识缺口之后才使用 real_issue。',
      ].join(' '),
    },
    en: {
      title: 'Record OMK human review',
      description: [
        'Record the user or reviewer decision for a captured observation.',
        'Use real_issue only after a human confirms the knowledge gap.',
      ].join(' '),
    },
  },
  draft_sample_from_observation: {
    zh: {
      title: '生成 OMK 回归评测草稿',
      description: [
        '持久化一条由人工确认过的反馈所提出的回归用例草稿。',
        '结果仍是草稿，不会改动正式用例集。',
        '题干与评分标准只能基于 get_observation 返回的、用户授权的证据。',
      ].join(' '),
    },
    en: {
      title: 'Draft OMK regression sample',
      description: [
        'Persist a candidate regression sample proposed from a human-confirmed observation.',
        'The result remains a draft and never changes the formal eval sample set.',
        'Base the prompt and rubric only on user-authorized evidence returned by get_observation.',
      ].join(' '),
    },
  },
  review_observation: {
    zh: {
      title: 'OMK 知识反馈',
      description: [
        '展示某条反馈对应的内嵌复核组件。',
        '先调用 get_observation，只依据其中经授权的证据提出回归题干，',
        '再把 observationId 与可选的提案传给本工具。',
      ].join(' '),
    },
    en: {
      title: 'OMK knowledge feedback',
      description: [
        'Show the inline review component for an observation.',
        'First call get_observation, propose a regression prompt only from its authorized evidence,',
        'then pass the observationId and optional proposal to this tool.',
      ].join(' '),
    },
  },
  'omk-observation-review': {
    zh: {
      title: 'OMK 知识反馈复核',
      description: '查看用户授权的证据，记录人工结论，并生成回归评测草稿。',
    },
    en: {
      title: 'OMK knowledge feedback review',
      description: 'Inspect user-authorized evidence, record the human decision, and draft a regression sample.',
    },
  },
};

/** 展示语言选项：显式 `lang` 优先，否则按环境（OMK_LANG → 系统 locale → zh）推断。 */
export interface McpDisplayLanguage {
  lang?: Lang;
  env?: NodeJS.ProcessEnv;
}

export function resolveMcpDisplayLang(options: McpDisplayLanguage): Lang {
  return options.lang ?? resolveLanguagePreference({ env: options.env ?? process.env }).lang;
}

export function mcpDisplayCopy(name: string, lang: Lang): McpDisplayCopy {
  const entry = COPY[name];
  if (!entry) throw new Error(`mcp: no display copy registered for ${name}`);
  return entry[lang];
}

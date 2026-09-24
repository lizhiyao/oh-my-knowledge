import { headers } from 'next/headers';
import type { Metadata } from 'next';
import type { Language } from './shell';

/**
 * 浏览器标签标题词表：多标签同时开着评测运行、某个 skill 与某份健康报告时，标签名要分得清对象。
 * 词条一律取自页面上已有的可见措辞（面包屑、分区导航、`<h1>`），不另起一套只给标题用的命名；
 * 根 layout 的 `OMK · %s` 模板补上品牌前缀，等价于迁移前 HTML 外壳的 `<title>OMK · <页面名></title>`。
 */
const TITLES = {
  conversations: { zh: '对话列表', en: 'Conversations' },
  conversation: { zh: '对话详情', en: 'Conversation details' },
  task: { zh: '任务轨迹', en: 'Task trajectory' },
  inbox: { zh: '观测收件箱', en: 'Observation inbox' },
  health: { zh: 'Skill 健康度日报', en: 'Skill Health Reports' },
  healthTrend: { zh: 'Skill 趋势', en: 'Skill trend' },
  healthDiff: { zh: 'Skill 健康度对比', en: 'Skill health diff' },
  measure: { zh: '评测记录', en: 'Evaluations' },
  measureRun: { zh: '运行', en: 'Run' },
  knowledge: { zh: '知识载体', en: 'Knowledge artifacts' },
  candidates: { zh: '候选知识', en: 'Candidate knowledge' },
  managed: { zh: '受管决策史', en: 'Managed history' },
  agents: { zh: '来源与采集', en: 'Sources and collection' },
} as const;

type StudioPageTitle = keyof typeof TITLES;

/**
 * 请求语言的唯一读取点：语言是本机设置（宿主按请求注入 `x-omk-studio-lang`），不进地址。
 * 取不到注入（如脱离宿主的直接渲染）按内置默认 zh，与宿主的损坏降级同侧。
 */
export async function requestStudioLang(): Promise<Language> {
  return (await headers()).get('x-omk-studio-lang') === 'en' ? 'en' : 'zh';
}

/**
 * `subject` 取地址里的对象身份（运行 ID、skill 名、报告 ID），不读页面模型：
 * 标题只需要区分对象，不需要为它再触发一次数据装载。
 */
export function pageTitle(kind: StudioPageTitle, lang: Language, subject?: string): Metadata {
  const label = TITLES[kind][lang];
  return { title: subject ? `${label} · ${subject}` : label };
}

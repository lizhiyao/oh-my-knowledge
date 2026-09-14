import type { Metadata } from 'next';
import type { Language } from './shell';

/**
 * 浏览器标签标题词表：多标签同时开着评测运行、某个 skill 与某份健康报告时，标签名要分得清对象。
 * 词条一律取自页面上已有的可见措辞（面包屑、分区导航、`<h1>`），不另起一套只给标题用的命名；
 * 根 layout 的 `OMK · %s` 模板补上品牌前缀，等价于迁移前 HTML 外壳的 `<title>OMK · <页面名></title>`。
 */
const TITLES = {
  conversations: { zh: '会话列表', en: 'Conversations' },
  conversation: { zh: '会话详情', en: 'Conversation details' },
  task: { zh: '任务轨迹', en: 'Task trajectory' },
  inbox: { zh: '观测收件箱', en: 'Observation inbox' },
  health: { zh: 'Skill 健康度日报', en: 'Skill Health Reports' },
  healthTrend: { zh: 'Skill 趋势', en: 'Skill trend' },
  healthDiff: { zh: 'Skill 健康度对比', en: 'Skill health diff' },
  measure: { zh: '评测记录', en: 'Evaluations' },
  measureRun: { zh: '运行', en: 'Run' },
  knowledge: { zh: '知识对象', en: 'Knowledge artifacts' },
  managed: { zh: '受管决策史', en: 'Managed history' },
} as const;

type StudioPageTitle = keyof typeof TITLES;

export function studioLang(searchParams: { lang?: string }): Language {
  return searchParams.lang === 'en' ? 'en' : 'zh';
}

/**
 * `subject` 取地址里的对象身份（运行 ID、skill 名、报告 ID），不读页面模型：
 * 标题只需要区分对象，不需要为它再触发一次数据装载。
 */
export function pageTitle(kind: StudioPageTitle, lang: Language, subject?: string): Metadata {
  const label = TITLES[kind][lang];
  return { title: subject ? `${label} · ${subject}` : label };
}

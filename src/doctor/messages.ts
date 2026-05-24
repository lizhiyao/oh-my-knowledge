import type { Lang } from '../types/shared.js';

/**
 * doctor 子系统自有的 i18n 字典。
 *
 * 设计动机:doctor 是 omk 的基础检查层,不应该反向 import CLI 的 i18n。文案归属
 * 在 doctor 自己手里,CLI 装配层只在最外层负责选 lang。
 *
 * key 继续沿用 `cli.doctor.*` 前缀,因为 labelKey 字符串(`cli.doctor.rule.xxx` 等)
 * 已经作为 DoctorRule / HealthDimensionSpec 的稳定标识贯穿全代码与测试 fixture;
 * 这里只是把翻译表本地化,key 命名空间不动以降低改动面。renderer 通过
 * `key in DOCTOR_MESSAGES` 做动态查表,自定义 rule 用未知 key 时会 fallback 到 ruleId。
 */

interface MessageEntry {
  zh: string;
  en: string;
}

export type DoctorMessageKey =
  | 'cli.doctor.rule.skill_readable'
  | 'cli.doctor.rule.skill_metadata'
  | 'cli.doctor.rule.dependencies'
  | 'cli.doctor.rule.samples_contract'
  | 'cli.doctor.rule.skill_health_check'
  | 'cli.doctor.health.skipped'
  | 'cli.doctor.health.no_dimensions'
  | 'cli.doctor.health.fail.executor'
  | 'cli.doctor.health.fail.parse'
  | 'cli.doctor.health.fail.empty_output'
  | 'cli.doctor.health.hint.executor'
  | 'cli.doctor.health.hint.parse'
  | 'cli.doctor.health.dim.message'
  | 'cli.doctor.health.dim.missing'
  | 'cli.doctor.health.summary.label'
  | 'cli.doctor.health.summary.message'
  | 'cli.doctor.health.summary.no_top'
  | 'cli.doctor.health.dim.trigger-boundary'
  | 'cli.doctor.health.dim.doc-clarity'
  | 'cli.doctor.health.dim.instr-precision'
  | 'cli.doctor.health.dim.dependency'
  | 'cli.doctor.health.dim.tool-conventions'
  | 'cli.doctor.health.dim.security'
  | 'cli.doctor.health.dim.examples'
  | 'cli.doctor.skill_readable.pass'
  | 'cli.doctor.skill_metadata.pass'
  | 'cli.doctor.dependencies.pass'
  | 'cli.doctor.samples_contract.pass'
  | 'cli.doctor.skill_readable.fail.missing'
  | 'cli.doctor.skill_readable.fail.empty'
  | 'cli.doctor.skill_readable.fail.too_short'
  | 'cli.doctor.skill_readable.hint.missing'
  | 'cli.doctor.skill_readable.hint.too_short'
  | 'cli.doctor.skill_metadata.fail.frontmatter_invalid'
  | 'cli.doctor.skill_metadata.fail.hardrules_invalid'
  | 'cli.doctor.skill_metadata.fail.workflows_invalid'
  | 'cli.doctor.skill_metadata.fail.missing_skillmd'
  | 'cli.doctor.skill_metadata.hint.frontmatter'
  | 'cli.doctor.skill_metadata.hint.hardrules'
  | 'cli.doctor.skill_metadata.hint.workflows'
  | 'cli.doctor.skill_metadata.hint.missing_skillmd'
  | 'cli.doctor.dependencies.fail'
  | 'cli.doctor.dependencies.hint.tool'
  | 'cli.doctor.dependencies.hint.file'
  | 'cli.doctor.dependencies.hint.env'
  | 'cli.doctor.dependencies.hint.preflight'
  | 'cli.doctor.dependencies.issue.tool_not_found'
  | 'cli.doctor.dependencies.issue.file_not_found'
  | 'cli.doctor.dependencies.issue.env_not_set'
  | 'cli.doctor.dependencies.issue.preflight_failed'
  | 'cli.doctor.samples_contract.skipped'
  | 'cli.doctor.samples_contract.warn.empty'
  | 'cli.doctor.samples_contract.warn.missing_prompt'
  | 'cli.doctor.samples_contract.hint';

export const DOCTOR_MESSAGES: Record<DoctorMessageKey, MessageEntry> = {
  // ---------------- rule labels ----------------
  'cli.doctor.rule.skill_readable': {
    zh: 'skill 文件可读',
    en: 'skill file readable',
  },
  'cli.doctor.rule.skill_metadata': {
    zh: 'skill 元数据合法',
    en: 'skill metadata valid',
  },
  'cli.doctor.rule.dependencies': {
    zh: '前置依赖完整',
    en: 'dependencies present',
  },
  'cli.doctor.rule.samples_contract': {
    zh: '用例 ↔ skill 输入约定',
    en: 'samples ↔ skill contract',
  },
  'cli.doctor.rule.skill_health_check': {
    zh: '健康度体检',
    en: 'Health check',
  },
  // ---------------- skill_health composer ----------------
  'cli.doctor.health.skipped': {
    zh: '健康度体检已跳过(runHealthCheck=false)',
    en: 'health check skipped (runHealthCheck=false)',
  },
  'cli.doctor.health.no_dimensions': {
    zh: '没有注册任何健康度维度,跳过',
    en: 'no health dimensions registered, skipped',
  },
  'cli.doctor.health.fail.executor': {
    zh: 'LLM 调用失败: {error}',
    en: 'LLM call failed: {error}',
  },
  'cli.doctor.health.fail.parse': {
    zh: 'LLM 输出解析失败: {error}',
    en: 'failed to parse LLM output: {error}',
  },
  'cli.doctor.health.fail.empty_output': {
    zh: 'LLM 返回了空输出',
    en: 'LLM returned empty output',
  },
  'cli.doctor.health.hint.executor': {
    zh: '检查 executor 配置(--executor / --model)与网络连通,或调大 --timeout',
    en: 'Verify executor config (--executor / --model) and connectivity, or raise --timeout',
  },
  'cli.doctor.health.hint.parse': {
    zh: 'LLM 没返回合法 JSON;原文存在 detail.rawOutput 截断片段,可重跑或换 model',
    en: 'LLM did not return valid JSON; raw snippet stored in detail.rawOutput. Re-run or switch model',
  },
  'cli.doctor.health.dim.message': {
    zh: '{level}: 错误 {err}/警告 {warn}/建议 {sug}',
    en: '{level}: error {err}/warn {warn}/suggest {sug}',
  },
  'cli.doctor.health.dim.missing': {
    zh: 'LLM 未输出此维度({dim}),已置不适用',
    en: 'LLM omitted dimension ({dim}); treated as N/A',
  },
  'cli.doctor.health.summary.label': {
    zh: '健康度总览',
    en: 'Health summary',
  },
  'cli.doctor.health.summary.message': {
    zh: '{overall} | 维度: 健康 {h}/亚健康 {sh}/不健康 {bad}/不适用 {na} | finding: 错误 {err}/警告 {warn}/建议 {sug}',
    en: '{overall} | dims: healthy {h}/sub {sh}/unhealthy {bad}/n-a {na} | findings: err {err}/warn {warn}/sug {sug}',
  },
  'cli.doctor.health.summary.no_top': {
    zh: '完整详情见 --json 输出或 --html 报告',
    en: 'Full detail in --json output or --html report',
  },
  // ---------------- 7 内置维度 labelKey ----------------
  'cli.doctor.health.dim.trigger-boundary': { zh: '触发与边界', en: 'Trigger & boundary' },
  'cli.doctor.health.dim.doc-clarity':      { zh: '文档清晰',   en: 'Documentation clarity' },
  'cli.doctor.health.dim.instr-precision':  { zh: '指令精确性', en: 'Instruction precision' },
  'cli.doctor.health.dim.dependency':       { zh: '依赖检查',   en: 'Dependency check' },
  'cli.doctor.health.dim.tool-conventions': { zh: '工具规范',   en: 'Tool conventions' },
  'cli.doctor.health.dim.security':         { zh: '安全与合规', en: 'Security & compliance' },
  'cli.doctor.health.dim.examples':         { zh: '示例完备',   en: 'Example completeness' },
  // ---------------- pass ----------------
  'cli.doctor.skill_readable.pass': {
    zh: 'skill 内容长度 {length} 字符',
    en: 'skill content {length} chars',
  },
  'cli.doctor.skill_metadata.pass': {
    zh: '元数据格式合法',
    en: 'metadata format valid',
  },
  'cli.doctor.dependencies.pass': {
    zh: '依赖检查通过',
    en: 'all dependencies present',
  },
  'cli.doctor.samples_contract.pass': {
    zh: '用例 {count} 条,prompt 字段齐全',
    en: '{count} samples, all with prompt',
  },
  // ---------------- skill_readable ----------------
  'cli.doctor.skill_readable.fail.missing': {
    zh: 'skill 文件无内容(content 为空)',
    en: 'skill file has no content (content is null)',
  },
  'cli.doctor.skill_readable.fail.empty': {
    zh: 'skill 文件 trim 后为空',
    en: 'skill file is empty after trim',
  },
  'cli.doctor.skill_readable.fail.too_short': {
    zh: 'skill 内容过短(只有 {length} 字符,最低 10)',
    en: 'skill content too short ({length} chars, minimum 10)',
  },
  'cli.doctor.skill_readable.hint.missing': {
    zh: 'skill 文件未读到内容(尝试路径: {path})。用 `ls -la {path}` 确认文件存在,用 `cat {path}` 确认可读且非空',
    en: 'no content read from skill (tried path: {path}). Run `ls -la {path}` to verify it exists and `cat {path}` to confirm it is readable and non-empty',
  },
  'cli.doctor.skill_readable.hint.too_short': {
    zh: 'skill 至少需要写一句完整的指令,过短的内容评测出来无意义',
    en: 'a skill needs at least a full instruction sentence — too short content yields meaningless eval',
  },
  // ---------------- skill_metadata ----------------
  'cli.doctor.skill_metadata.fail.frontmatter_invalid': {
    zh: 'front-matter 格式错误: {error}',
    en: 'front-matter format error: {error}',
  },
  'cli.doctor.skill_metadata.fail.hardrules_invalid': {
    zh: 'hardRules 结构错误: {error}',
    en: 'hardRules schema error: {error}',
  },
  'cli.doctor.skill_metadata.fail.workflows_invalid': {
    zh: 'workflows 结构错误: {error}',
    en: 'workflows schema error: {error}',
  },
  'cli.doctor.skill_metadata.fail.missing_skillmd': {
    zh: 'directory-skill 缺少 SKILL.md 入口文件',
    en: 'directory-skill missing SKILL.md entry file',
  },
  'cli.doctor.skill_metadata.hint.frontmatter': {
    zh: 'front-matter 用 YAML 语法,key: value 或 - item 形式。可参考 examples/multi-skills 下的 skill 写法',
    en: 'front-matter uses YAML syntax (key: value or - item). See examples/multi-skills for reference',
  },
  'cli.doctor.skill_metadata.hint.hardrules': {
    zh: 'hardRules 必须写在 SKILL.md front-matter 中,格式为 hardRules: [{ id, rule, expectedBehavior }]；id 要稳定且唯一,expectedBehavior 写可观察行为。',
    en: 'hardRules must live in SKILL.md front-matter as hardRules: [{ id, rule, expectedBehavior }]; id must be stable and unique, expectedBehavior should describe observable behavior.',
  },
  'cli.doctor.skill_metadata.hint.workflows': {
    zh: 'workflows 必须写在 SKILL.md front-matter 中,格式为 workflows: [{ id, description, nodes: [{ id, action }] }]；nodes 也兼容 steps 别名。',
    en: 'workflows must live in SKILL.md front-matter as workflows: [{ id, description, nodes: [{ id, action }] }]; nodes also accepts the steps alias.',
  },
  'cli.doctor.skill_metadata.hint.missing_skillmd': {
    zh: 'directory-skill 必须有 SKILL.md 文件作为入口。或将 skill 写成单文件 .md',
    en: 'directory-skills require a SKILL.md entry file. Alternatively, write the skill as a single .md file',
  },
  // ---------------- dependencies ----------------
  'cli.doctor.dependencies.fail': {
    zh: '前置依赖检查失败: {summary}',
    en: 'dependency check failed: {summary}',
  },
  'cli.doctor.dependencies.hint.tool': {
    zh: '工具缺失: 安装到 PATH 或更新 skill 的 requires.tools 引用名',
    en: 'missing tool: install it on PATH or update skill\'s requires.tools entry',
  },
  'cli.doctor.dependencies.hint.file': {
    zh: '文件缺失: 检查路径是否相对 skill 目录正确,或更新 skill 的 requires.files 引用',
    en: 'missing file: verify path is relative to skill dir, or update skill\'s requires.files entry',
  },
  'cli.doctor.dependencies.hint.env': {
    zh: '环境变量缺失: 在 .env / shell profile 里 export,或在 CI secrets 中配置',
    en: 'missing env: export it in .env / shell profile, or configure it in CI secrets',
  },
  'cli.doctor.dependencies.hint.preflight': {
    zh: 'preflight 命令失败: 看上面的失败原因定位根因,或调整 skill 的 preflight 命令',
    en: 'preflight command failed: read the failure reason above, or adjust the skill\'s preflight command',
  },
  'cli.doctor.dependencies.issue.tool_not_found': {
    zh: '工具 {name} 未找到 (不在 PATH 中)',
    en: 'tool {name} not found on PATH',
  },
  'cli.doctor.dependencies.issue.file_not_found': {
    zh: '文件 {name} 不存在 (cwd: {detail})',
    en: 'file {name} not found (cwd: {detail})',
  },
  'cli.doctor.dependencies.issue.env_not_set': {
    zh: '环境变量 {name} 未设置',
    en: 'env var {name} not set',
  },
  'cli.doctor.dependencies.issue.preflight_failed': {
    zh: 'preflight 命令 "{name}" 执行失败: {detail}',
    en: 'preflight command "{name}" failed: {detail}',
  },
  // ---------------- samples_contract ----------------
  'cli.doctor.samples_contract.skipped': {
    zh: '未提供 samples,跳过此项检查',
    en: 'no samples provided, skipped',
  },
  'cli.doctor.samples_contract.warn.empty': {
    zh: 'samples 列表为空',
    en: 'samples list is empty',
  },
  'cli.doctor.samples_contract.warn.missing_prompt': {
    zh: '{count} 条用例缺 prompt 字段',
    en: '{count} samples missing prompt field',
  },
  'cli.doctor.samples_contract.hint': {
    zh: '用例必须至少包含 prompt 字段。详见 docs/specs/sample-design-spec.md',
    en: 'samples must contain at least a prompt field. See docs/specs/sample-design-spec.md',
  },
};

const DEFAULT_LANG: Lang = 'zh';

export function tDoctorMessage(
  key: DoctorMessageKey,
  lang: Lang = DEFAULT_LANG,
  params?: Record<string, string | number>,
): string {
  const entry = DOCTOR_MESSAGES[key];
  let text = entry[lang] ?? entry[DEFAULT_LANG];
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replaceAll(`{${k}}`, String(v));
    }
  }
  return text;
}

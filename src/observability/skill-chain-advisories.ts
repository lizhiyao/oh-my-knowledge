/**
 * inbox 报告侧的 skill-chain 改进建议字典。
 *
 * 仅为 inbox UI 展示用，不动 doctor 的 pass/fail 语义。
 * code 命名风格与 doctor i18n key（如 `skill_metadata.hint.hardrules`）对齐，
 * 这样将来 doctor 若也要展示同样的提示，code 可复用。
 */

export type SkillChainAdvisoryCode =
  | 'hardrules_not_declared'
  | 'workflows_not_declared'
  | 'skill_md_not_found';

export interface SkillChainAdvisory {
  code: SkillChainAdvisoryCode;
  message: string;
  /** 可选：例子 yaml（hardrules / workflows 用） */
  exampleYaml?: string;
  /** 可选：建议命令模板，`${skillName}` 会被替换 */
  commandTemplate?: string;
  /** advisory 在 L1 辅助推断里展示的简短 caution 标签（不超过 18 字） */
  shortLabel: string;
}

const ADVISORIES: Record<SkillChainAdvisoryCode, SkillChainAdvisory> = {
  hardrules_not_declared: {
    code: 'hardrules_not_declared',
    shortLabel: '未声明 hardRules',
    message: '未声明结构化 hardRules，运行时规则审计无法进行。建议在 SKILL.md frontmatter 补充。',
    exampleYaml: [
      '---',
      'name: your-skill',
      'description: ...',
      'hardRules:',
      '  - id: must-confirm-project',
      '    rule: 生成前先确认 projectId',
      '    expectedBehavior: 调用方未提供 projectId 时主动追问，不要凭空生成',
      '  - id: read-domain-first',
      '    rule: 必须读取领域知识',
      '    expectedBehavior: 先读 domain/*.md，缺失就降级提示，禁止跳过',
      '---',
    ].join('\n'),
  },
  workflows_not_declared: {
    code: 'workflows_not_declared',
    shortLabel: '未声明 workflows',
    message: '未声明 workflows，无法对照标准执行链路。建议在 SKILL.md frontmatter 补充。',
    exampleYaml: [
      '---',
      'name: your-skill',
      'workflows:',
      '  - id: main',
      '    description: 标准主流程',
      '    nodes:',
      '      - id: collect-input',
      '        action: 收集需求与上下文',
      '      - id: read-domain',
      '        action: 读取领域知识',
      '      - id: generate',
      '        action: 生成产物',
      '      - id: upload',
      '        action: 上传到需求管理系统',
      '---',
    ].join('\n'),
  },
  skill_md_not_found: {
    code: 'skill_md_not_found',
    shortLabel: '本地未找到 SKILL.md',
    message: '本地常见 skill 目录里没有这个 skill 的 SKILL.md，inbox 跑不了静态/运行时审计。如果你想看更多体检维度（依赖检查、可读性等），可以试试 omk doctor；inbox 本身不依赖它。',
    commandTemplate: 'omk doctor ~/.claude/skills/${skillName}/SKILL.md --static-only',
  },
};

export function getSkillChainAdvisory(code: SkillChainAdvisoryCode): SkillChainAdvisory {
  return ADVISORIES[code];
}

/**
 * 把 commandTemplate 里的 `${skillName}` 占位符替换成实际 skill 名。
 * 只接受字母/数字/横线/下划线，避免 shell 注入风险。
 */
export function resolveAdvisoryCommand(advisory: SkillChainAdvisory, skillName: string): string | undefined {
  if (!advisory.commandTemplate) return undefined;
  const safe = /^[A-Za-z0-9_.-]+$/.test(skillName) ? skillName : '<skill-name>';
  return advisory.commandTemplate.replace(/\$\{skillName\}/g, safe);
}

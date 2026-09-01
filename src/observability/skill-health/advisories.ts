/**
 * inbox 报告侧的 skill-chain 改进建议字典。
 *
 * 仅为 inbox UI 展示用，不动 doctor 的 pass/fail 语义。
 * code 命名风格与 doctor i18n key（如 `skill_metadata.hint.hardrules`）对齐，
 * 这样将来 doctor 若也要展示同样的提示，code 可复用。
 */

import type { SkillChainAdvisory, SkillChainAdvisoryCode } from '../contracts/skill-chain-advisories.js';

export type { SkillChainAdvisory, SkillChainAdvisoryCode };

const ADVISORIES: Record<SkillChainAdvisoryCode, SkillChainAdvisory> = {
  hardrules_not_declared: {
    code: 'hardrules_not_declared',
    shortLabel: '未标准化 hardRules',
    message: '未在 SKILL.md frontmatter 标准化声明 hardRules。以下内容为检测结果；建议沉淀为标准化 hardRules。',
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
    shortLabel: '未标准化 workflows',
    message: '未在 SKILL.md frontmatter 标准化声明 workflows。以下内容为检测结果；建议沉淀为标准化 workflows。',
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
    message: '本地常见 skill 目录里没有这个 skill 的 SKILL.md，inbox 跑不了静态/运行时审计。如果你想看 LLM 健康度审计（触发边界 / 文档 / 依赖 / 安全等 7 维），可以试试 omk doctor；inbox 本身不依赖它。',
    commandTemplate: 'omk doctor /path/to/${skillName}/SKILL.md',
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

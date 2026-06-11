import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tCli, type CliLang } from './i18n.js';

// 项目脚手架的共享落盘逻辑 —— `omk eval init`(收敛后命名)与 `omk init`(长期保留的别名)共用同一份实现,
// 命令类只负责 parse 入参与各自的提示文案,避免两处复制模板 / 落盘逻辑漂移。

const INIT_SAMPLES = `[
  {
    "sample_id": "s001",
    "prompt": "审查以下代码",
    "context": "function authenticate(username, password) {\\n  const query = \`SELECT * FROM users WHERE name='\${username}' AND pass='\${password}'\`;\\n  return db.execute(query);\\n}",
    "rubric": "应识别 SQL 注入风险，建议使用参数化查询",
    "assertions": [
      { "type": "contains", "value": "SQL", "weight": 1 },
      { "type": "contains", "value": "injection", "weight": 1 },
      { "type": "regex", "pattern": "parameterized|prepared|placeholder|bind", "flags": "i", "weight": 0.5 },
      { "type": "not_contains", "value": "looks good", "weight": 0.5 }
    ],
    "dimensions": {
      "security": "是否准确识别出 SQL 注入漏洞并说明其危害",
      "actionability": "是否给出可直接使用的参数化查询修复代码"
    }
  },
  {
    "sample_id": "s002",
    "prompt": "审查以下代码",
    "context": "async function fetchData(url) {\\n  const res = await fetch(url);\\n  const data = await res.json();\\n  return data;\\n}",
    "rubric": "应指出缺少错误处理（网络异常、非 JSON 响应、HTTP 错误状态码）",
    "assertions": [
      { "type": "contains", "value": "error handling", "weight": 1 },
      { "type": "regex", "pattern": "try[\\\\s\\\\S]*catch|exception|error", "flags": "i", "weight": 1 },
      { "type": "contains", "value": "status", "weight": 0.5 }
    ],
    "dimensions": {
      "robustness": "是否指出了所有缺失的错误处理场景",
      "actionability": "是否给出了完整的 try-catch 修复代码"
    }
  },
  {
    "sample_id": "s003",
    "prompt": "审查以下代码",
    "context": "function renderComment(comment) {\\n  document.getElementById('output').innerHTML = '<p>' + comment + '</p>';\\n}",
    "rubric": "应识别 XSS 风险，建议使用 textContent 或转义 HTML",
    "assertions": [
      { "type": "contains", "value": "XSS", "weight": 1 },
      { "type": "regex", "pattern": "textContent|escape|sanitize|sanitizer", "flags": "i", "weight": 1 },
      { "type": "contains", "value": "innerHTML", "weight": 0.5 }
    ],
    "dimensions": {
      "security": "是否准确识别出 XSS 漏洞并说明攻击方式",
      "actionability": "是否给出使用 textContent 或转义的修复代码"
    }
  }
]
`;

// 模板带 Claude Code SKILL.md 兼容 frontmatter(name + description),让用户
// 可以把 init 出来的 SKILL.md 直接 deploy 到 ~/.claude/skills/ 给 Claude Code 用,
// 一份文件双向 dogfood(omk 评测 + Claude 部署)。omk 当前不 strip frontmatter,
// 它会跟着 leak 进 system prompt — 在 model 行为层面是无害噪声,跨 executor 一致。
const INIT_SKILL_V1 = `---
name: code-review-v1
description: 简单代码审查 skill,识别明显问题
---

# Code review v1

你是一个代码审查助手。请审查用户提供的代码，指出潜在问题。
`;

const INIT_SKILL_V2 = `---
name: code-review-v2
description: 多维度代码审查,覆盖安全 / 健壮 / 可维护 / 性能,带严重程度标注
---

# Code review v2

你是一个高级代码审查专家。请从以下维度审查用户提供的代码：

1. 安全性：是否存在注入、XSS、敏感信息泄露等风险
2. 健壮性：是否有适当的错误处理和边界检查
3. 可维护性：命名是否清晰、结构是否合理
4. 性能：是否存在明显的性能瓶颈

对每个维度给出具体的改进建议，并标注严重程度（高/中/低）。
`;

/** 在 targetDir 落 skills/ + eval-samples.json 模板,并打印下一步指引。命令类只调它。 */
export function scaffoldInitProject(targetDir: string, lang: CliLang): void {
  // omk skill loader 把 `skills/<name>/SKILL.md` 子目录识别为 directory-skill,
  // cwd 默认锚到 skill 根目录,后续可在同目录下放 assets / 子文档。
  mkdirSync(join(targetDir, 'skills', 'code-review-v1'), { recursive: true });
  mkdirSync(join(targetDir, 'skills', 'code-review-v2'), { recursive: true });
  writeFileSync(join(targetDir, 'eval-samples.json'), INIT_SAMPLES);
  writeFileSync(join(targetDir, 'skills', 'code-review-v1', 'SKILL.md'), INIT_SKILL_V1);
  writeFileSync(join(targetDir, 'skills', 'code-review-v2', 'SKILL.md'), INIT_SKILL_V2);

  console.log(tCli('cli.init.scaffolded', lang, { dir: targetDir }));
  console.log('');
  console.log(tCli('cli.init.next_steps_title', lang));
  console.log(tCli('cli.init.next_step_edit_samples', lang));
  console.log(tCli('cli.init.next_step_edit_skills', lang));
  console.log(tCli('cli.init.next_step_run', lang));
  console.log(tCli('cli.init.note_codex_executor', lang));
}

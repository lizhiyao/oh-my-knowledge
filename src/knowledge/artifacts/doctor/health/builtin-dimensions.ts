/**
 * 7 个内置健康度维度的 spec。
 *
 * 内置维度的 promptSection 完整保留原 Python 版的检查项内容(不写 ## N. 标题,
 * 框架按注册顺序自动编号)。severity 区分:
 *   - fatal: trigger-boundary / dependency / security  → `不健康` 时让 doctor outcome=failed
 *   - warn:  doc-clarity / instr-precision / tool-conventions / examples
 */

import type { HealthDimensionSpec } from './dimension-spec.js';

export const BUILTIN_HEALTH_DIMENSIONS: HealthDimensionSpec[] = [
  {
    id: 'trigger-boundary',
    displayName: '触发与边界',
    labelKey: 'cli.doctor.health.dim.trigger-boundary',
    severity: 'fatal',
    promptSection: `**该触发时准 + 不该触发时不误用**
- frontmatter 的 \`description\` / \`when_to_use\` 是否与正文功能**矛盾**?
- 关键词与相邻 skill 严重重叠且没有说明分工,可能导致**误触发**?`,
  },
  {
    id: 'doc-clarity',
    displayName: '文档清晰',
    labelKey: 'cli.doctor.health.dim.doc-clarity',
    severity: 'warn',
    promptSection: `**文档结构是否导致 LLM 理解出错**
- 步骤顺序是否自相矛盾或循环依赖,导致 LLM 无法确定执行顺序?
- 关键决策分支是否缺失,导致 LLM 在该分支下无指令可循?
注意:冗余、不够简洁、缺少参数示例等**不影响 LLM 理解**的问题不要报。`,
  },
  {
    id: 'instr-precision',
    displayName: '指令精确性',
    labelKey: 'cli.doctor.health.dim.instr-precision',
    severity: 'warn',
    promptSection: `**指令是否会导致 LLM 多次执行产生截然不同的结果**
- 同一文档内对同一事实给出**矛盾说法**(如 cron 表达式与时区描述不一致)
- 关键操作的目标对象**完全没有限定**,LLM 可能操作错误对象
注意:模糊量词、缺少 else 分支、措辞不统一等,只要 LLM 能从上下文合理推断就不要报。`,
  },
  {
    id: 'dependency',
    displayName: '依赖检查',
    labelKey: 'cli.doctor.health.dim.dependency',
    severity: 'fatal',
    promptSection: `**依赖在 + 不重复造轮子 + 路径可移植**
- 引用的脚本 / CLI / MCP 工具 / 其他 skill 实际存在
- 不内联底层(应该引用某 skill 时却内联了它的实现)
- **路径可移植**:不能硬编码具体版本号路径(eg. \`~/.nvm/versions/node/v22.22.0/...\`)、用户专属路径(eg. \`/Users/<具体人>/...\`)、机器专属位置——这些在换用户 / 换 Node 版本 / 换安装方式时**直接跑不通**,属于 \`错误\` 级。
  **例外:以下路径不算硬编码,不要报错**:
  - \`~/.<appname>/...\` 形式的用户配置/数据目录(如 \`~/.config/xxx\`、\`~/.local/bin/xxx\`)——这是 Unix 标准约定,\`~\` 会在运行时展开为当前用户 home,跨用户可移植。
  - 环境变量引用(如 \`$HOME/...\`、\`$SKILL_DIR/...\`)。

  **改进建议必须用运行时中立的方案**:
  - **skill 内部资源**(\`scripts/\`、\`references/\`、\`mcp.json\` 等):**统一用 \`$SKILL_DIR\` 指代本 skill 加载后的实际根目录(即 SKILL.md 所在目录)**,执行命令时由调用方替换为绝对路径。SKILL.md 里只需在前置说明里加一句:"\`$SKILL_DIR\` 指代本 skill 加载后的实际根目录,执行命令时直接替换为该绝对路径"。
  - **外部全局 npm 包路径**(eg. \`~/.nvm/versions/node/v22.22.0/lib/node_modules/...\`):改进建议**唯一推荐 \`npm root -g\`**,不要给其它替代方案。
  - **其它外部 CLI**(非 npm 包):用 \`which xxx\` 等动态解析,**不要**写死具体安装前缀或版本路径。
  - **禁止**推荐任何**单一运行时**绑定的机制(skill 可能在多种宿主下运行)。具体不要建议:
    - Claude 专属:\`$CLAUDE_PLUGIN_ROOT\` / \`~/.claude/\` / \`.claude/\` / 把 \`claude\` CLI 当强依赖
    - OpenClaw 专属:\`$OPENCLAW_*\` / 假设 cwd 在某固定位置
    - 任何把"宿主"写死到 skill 文档里的方案`,
  },
  {
    id: 'tool-conventions',
    displayName: '工具规范',
    labelKey: 'cli.doctor.health.dim.tool-conventions',
    severity: 'warn',
    promptSection: `**工具调用是否会导致执行失败**
- 工具名或参数格式明显写错,调用必失败?
- 关键工具失败时没有任何降级指令,且该失败会导致整个流程卡死?
注意:LLM 有内置的错误处理能力,只报那些 LLM 自己无法合理应对的情况。`,
  },
  {
    id: 'security',
    displayName: '安全与合规',
    labelKey: 'cli.doctor.health.dim.security',
    severity: 'fatal',
    promptSection: `**3 个 subtype,每条 finding 必须标 subtype**
- \`不可逆操作\`:\`rm -rf\` / \`git push -f\` / \`git reset --hard\` / \`git clean -fd\` / \`git branch -D\` / \`DROP TABLE\` / \`TRUNCATE\` / 不带 \`WHERE\` 的 \`DELETE\` / \`UPDATE\` / \`--no-verify\` 跳过 hook 等,**没有要求人工确认 / 先 dry-run / 限定 scope**
- \`凭据硬编码\`:写死的 token / AK / SK / cookie / password(非占位符)
- \`个人化耦合\`:真实工号 / 真实花名 / 真实邮箱(无"示例:"前缀) / 个人专属路径(\`/Users/<具体人名>/...\`)`,
  },
  {
    id: 'examples',
    displayName: '示例完备',
    labelKey: 'cli.doctor.health.dim.examples',
    severity: 'warn',
    promptSection: `**缺少示例是否会导致 LLM 完全无法理解如何调用**
- skill 描述了复杂的输入格式但完全没有示例,LLM 无法构造正确的调用?
注意:大多数 skill 即使没有示例,LLM 也能从指令描述中推断出正确用法。只有格式确实复杂且无法从描述中推断时才报。`,
  },
];

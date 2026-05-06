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
- frontmatter 的 \`description\` / \`when_to_use\` 是否与正文功能一致?
- 关键词与相邻 skill 的区分度是否足够?(关键词 < 3 个或全是泛词 = 区分度差)
- 是否**显式声明了不适用范围**?(eg. "本 skill 不处理 X、X 请走 Y skill"、"仅适用 dev 环境")
- 关键词与其他系统 skill 严重重叠时,是否说明了分工?`,
  },
  {
    id: 'doc-clarity',
    displayName: '文档清晰',
    labelKey: 'cli.doctor.health.dim.doc-clarity',
    severity: 'warn',
    promptSection: `**写得好不好读**
- 步骤顺序清楚、结构合理
- 没有大段冗余(明显可压 50%+ 的章节、无价值废话)
- 关键决策点显式标出
- 参数说明完整`,
  },
  {
    id: 'instr-precision',
    displayName: '指令精确性',
    labelKey: 'cli.doctor.health.dim.instr-precision',
    severity: 'warn',
    promptSection: `**给 LLM 的指令语义是否单一,多次执行不漂移**
- 模糊量词("一些" / "必要时" / "如有需要" / "适当地")
- 未限定主语("调用工具" 没说哪个工具)
- 条件分支没穷举("如果 X 就 A,否则..." 缺 else)
- 同一动作多种说法导致歧义
- 数量/阈值没说清("查几条"、"等一会儿")`,
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
    promptSection: `**调用方式标准 + 工具失败降级路径明确**
- 工具调用方式遵循统一约定(参数命名、返回格式)
- **工具失败 / 返回异常 / 数据为空时,skill 是否给了明确指令**(重试 / 跳过 / 中断并报告用户),而不是默认让 LLM 自由发挥`,
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
    promptSection: `**用户能否照着用、能否验证**
- 是否给了**典型调用示例**(用户输入 → 期望输出)?
- 是否说明了**如何验证调用成功**(看哪个文件 / log / 返回字段)?
- 关键参数是否有**示例值**,而不是只有类型说明?
- **失败 / 异常路径**是否有示意?`,
  },
];

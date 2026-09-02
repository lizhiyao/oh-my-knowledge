/**
 * 健康度体检 prompt 拼装器。
 *
 * 4 个区块:
 *   Block 1: 任务说明 + skill 输入(固定)
 *   Block 2: 检查维度章节(动态:遍历 dims,自动加 ## N. 标题 + (id: ...))
 *   Block 3: 通用规则(同根因合并 / Finding level / 维度 level / overall_health)
 *   Block 4: JSON schema(半动态:dim_id 枚举 + checklist 项数 = dims.length)
 *
 * 关键约束:LLM 用 dim_id(英文)在输出中标识维度,而不是中文 displayName —
 * displayName 翻译/重命名时不会让 parser 崩。
 */

import type { HealthDimensionSpec } from './dimension-spec.js';

export interface PromptInput {
  skillName: string;
  skillContent: string;
  skillRoot: string | null;
  subFiles: string[];
  siblingSkills: string[];
}

export function buildHealthPrompt(input: PromptInput, dims: HealthDimensionSpec[]): string {
  return [
    renderBlock1Header(input),
    renderBlock2Dimensions(dims),
    renderBlock3CommonRules(),
    renderBlock4JsonSchema(input.skillName, dims),
  ].join('\n\n');
}

// ---------------------------------------------------------------------------
// Block 1: 任务 + skill 输入
// ---------------------------------------------------------------------------

function renderBlock1Header(input: PromptInput): string {
  const { skillName, skillContent, skillRoot, subFiles, siblingSkills } = input;
  const siblingList = siblingSkills.length > 0
    ? siblingSkills.map((s) => `\`${s}\``).join(', ')
    : '(none)';
  const subFilesList = subFiles.length > 0
    ? subFiles.map((f) => `- ${f}`).join('\n')
    : '(no sub-files; pure SKILL.md skill)';
  const skillRootHint = skillRoot
    ? `skill 根目录: \`${skillRoot}\`(子文件需要时用 Read 工具自取)`
    : 'skill 是单文件 .md;没有子目录可 Read。';

  return `你正在对 \`${skillName}\` 这个 skill 做**健康度体检**——按下面注册的所有维度逐一检查,给出 level、findings、改进建议。

# 输入

- skill 名: \`${skillName}\`
- ${skillRootHint}
- 子文件清单(仅参考,需要时用 Read 工具按路径自取):
${subFilesList}

# 系统 skill 列表(跨 skill 引用判断用)

${siblingList}

## SKILL.md 内容(已 inline,无需再 Read)

\`\`\`markdown
${skillContent}
\`\`\``;
}

// ---------------------------------------------------------------------------
// Block 2: 维度章节
// ---------------------------------------------------------------------------

function renderBlock2Dimensions(dims: HealthDimensionSpec[]): string {
  const sections = dims.map((dim, idx) => {
    const num = idx + 1;
    return `## ${num}. ${dim.displayName} (id: \`${dim.id}\`)
${dim.promptSection.trim()}`;
  });
  return `# 检查维度

${sections.join('\n\n')}`;
}

// ---------------------------------------------------------------------------
// Block 3: 通用规则
// ---------------------------------------------------------------------------

function renderBlock3CommonRules(): string {
  return `# 同根因合并(去重规则)

多个 finding 如果**根因相同 + 修复方式相同**,必须合并成**一条** finding(可以跨维度合并)。在 \`description\` 里点明"在 N 处出现",\`suggestion\` 给统一修法。

合并后,该 finding 的 \`level\` 取所有出现位置中**最严重的一个**。

# Finding level 判定(严格控制数量)

**核心原则:LLM 理解能力很强,只报那些会导致执行失败或结果严重偏差的问题。文档写得"不够好"不是问题,"好到不会出错"就够了。**

- \`错误\`:**不修就跑不通或结果严重错误**。仅限以下情况:
  - 在常见用户环境下**直接跑不通**(路径不存在、脚本缺失、工具不可用)
  - 硬编码绝对路径含具体版本号 / 用户名 → 换环境必失败
  - 引用了不存在的脚本 / CLI / MCP 工具 / skill
  - 不可逆操作(rm -rf / git push -f 等)没有人工确认
  - 指令自相矛盾(同一文档内对同一事实给出冲突说法),LLM 无法判断哪个正确
- \`警告\`:仅限**有较大概率导致 LLM 执行偏差**的问题。以下情况**不要报警告**:
  - 文档措辞不够精炼但意思能理解
  - 缺少示例但指令本身清晰
  - 参数没给示例值但有类型说明
  - 模糊量词("一些"/"适当")在上下文中意思明确
  - 缺少显式声明但从上下文可合理推断的信息
- \`建议\`:**不要输出建议级别的 finding**。如果问题不够格做警告,就不要报。

**完整性:把该维度下**所有**够格(错误 / 警告)的真实问题都列出来,不要因为"已经报了几条"就漏掉同样真实的问题。同时严守上面的 level 门槛 —— 不够格的不要为了凑数硬塞。优先级:错误 > 警告。**

# 维度 level 派生规则

- \`健康\`:0 个 finding
- \`亚健康\`:有警告但无错误
- \`不健康\`:至少 1 个错误
- \`不适用\`:该维度对本 skill 无意义(谨慎使用,不要拿来回避检查)

# overall_health

- \`良好\`:所有维度都是 \`健康\` 或 \`不适用\`
- \`部分缺陷\`:有 \`亚健康\` 但无 \`不健康\`
- \`严重缺陷\`:任一维度 \`不健康\``;
}

// ---------------------------------------------------------------------------
// Block 4: JSON schema
// ---------------------------------------------------------------------------

function renderBlock4JsonSchema(skillName: string, dims: HealthDimensionSpec[]): string {
  const dimIdEnum = dims.map((d) => `"${d.id}"`).join(' | ');
  const dimIdList = dims.map((d) => `\`${d.id}\``).join(', ');

  return `# 输出 JSON schema

输出**必须是单一合法 JSON 对象**。第一字符 \`{\`,最后 \`}\`,**不要**用 \`\`\`json\`\`\` 围栏,**不要**寒暄。

{
  "skill_name": "${skillName}",
  "feature_points": [
    {
      "name": "<功能点名>",
      "description": "<1-2 行>",
      "simulation": [
        {
          "step": 1,
          "action": "<这一步做什么>",
          "input": "<参数>",
          "simulated_output": "<假设返回值,**不真跑**>",
          "derivable_from_doc": true,
          "note": "<指令模糊处>"
        }
      ]
    }
  ],
  "checklist": [
    {
      "dim_id": ${dimIdEnum},
      "level": "健康 | 亚健康 | 不健康 | 不适用",
      "findings": [
        {
          "level": "错误 | 警告",
          "subtype": "<仅 \`security\` 维度需填:不可逆操作 | 凭据硬编码 | 个人化耦合;其它维度留空字符串>",
          "description": "<一句话讲清问题>",
          "suggestion": "<针对这条问题的具体修改建议>"
        }
      ]
    }
  ],
  "summary": {
    "overall_health": "良好 | 部分缺陷 | 严重缺陷",
    "top_suggestions": ["<整 skill 视角下最该先改的 3 条,按优先级从高到低>"]
  }
}

# 字段约束

- \`checklist\` 必须**恰好包含 ${dims.length} 项**,\`dim_id\` 必须是以下之一,**每个 id 出现且仅出现一次**:
  ${dimIdList}
- \`level\` / \`subtype\` 字段值用精确中文字符串,不允许英文或别名
- 每条 finding 的 \`suggestion\` 必须是针对该条问题的具体修改建议,不要笼统
- 字符串里的 skill / 文件 / 命令名用反引号 \`xxx\` 包裹
- **不要**冒虚假 finding,宁可少报也不要把"看起来可能有问题"硬塞进来
- 不要输出 \`dimension_level_count\` / \`finding_count_by_level\` / \`suggestions\`(维度级别) 字段

读 SKILL.md(已 inline)→ 模拟执行 → 出 JSON。`;
}

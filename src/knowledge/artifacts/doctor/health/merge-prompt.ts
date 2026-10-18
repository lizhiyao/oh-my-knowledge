/**
 * 多采样 finding 归并 prompt(option C:LLM 合并 pass)。
 *
 * 健康度体检跑 N 次后,同一个根因问题常被不同次用**不同措辞**描述。纯字符串键
 * 去重(consensus.ts findingKey)对"措辞/引用写法不同"会漏并 —— 把同一问题拆成
 * 多条低支持度 finding。本 prompt 让 LLM 做一次跨采样聚类,把同根因 + 同修复方向
 * 的 finding 归到一组,框架再据此算 support(k/n)。
 *
 * 关键契约:
 *   - 只在维度内部并(不跨 dim_id),保持维度归属稳定。
 *   - 每个输入 finding 必须且只属于一个 cluster;无法并的自成一组。
 *   - 宁可不并,也不要把两个不同问题错并(over-merge 会藏掉真问题,比漏并更糟)。
 *   - LLM 只负责"哪些 id 归一组 + 合并后文案",**支持度 k/n 由框架算**(不信 LLM 算术)。
 */

import type { HealthDimensionSpec, HealthFinding } from './dimension-spec.js';

/** 一条带稳定 id 的采样 finding(来自第 sampleIdx 次采样、dimId 维度)。 */
export interface TaggedFindingView {
  id: string;
  dimId: string;
  finding: HealthFinding;
}

export function buildHealthMergePrompt(
  dims: HealthDimensionSpec[],
  tagged: TaggedFindingView[],
): string {
  // 按维度分组,只列出有 finding 的维度。
  const byDim = new Map<string, TaggedFindingView[]>();
  for (const t of tagged) {
    if (!byDim.has(t.dimId)) byDim.set(t.dimId, []);
    byDim.get(t.dimId)!.push(t);
  }

  const sections: string[] = [];
  for (const dim of dims) {
    const items = byDim.get(dim.id);
    if (!items || items.length === 0) continue;
    const lines = items.map((t) => {
      const f = t.finding;
      const sug = f.suggestion ? ` sug="${oneLine(f.suggestion)}"` : '';
      return `- [${t.id}] level=${f.level} desc="${oneLine(f.description ?? '')}"${sug}`;
    });
    sections.push(`## 维度 dim_id=\`${dim.id}\`\n${lines.join('\n')}`);
  }

  const allIds = tagged.map((t) => `\`${t.id}\``).join(', ');

  return `你在归并一个 skill 健康度体检的**多次采样结果**。下面是同一个 skill 跑了多次体检、各次产出的 finding(问题),按维度分组。同一个根因问题在不同次可能用**不同措辞**描述、引用文件名写法也可能不同。

# 任务

把**同根因 + 同修复方向**的 finding 归并成一组(cluster)。

# 规则

- **只在同一维度(dim_id)内部归并**,绝不跨维度合并。
- "同根因"判定:指向同一处缺陷、修复动作本质相同。措辞不同、引用文件名写法不同(如 \`templates/01-x.tmpl.md\` vs \`templates/<NN>-<name>.tmpl.md\`)**不影响**判定。
- **每个输入 finding 必须且只能属于一个 cluster**。和谁都并不了的,自成一个单元素 cluster。
- **宁可不并,也不要把两个不同的问题错并成一组** —— 错并会藏掉真问题,比漏并更糟。
- 每个 cluster 给一句最准确的合并后 \`description\` 和一条合并后 \`suggestion\`;\`level\` 取该组最严重的(错误 > 警告)。

# 输入

${sections.join('\n\n')}

# 输出 JSON schema

输出**必须是单一合法 JSON 对象**。第一字符 \`{\`,最后 \`}\`,**不要**用 \`\`\`json\`\`\` 围栏,**不要**寒暄。

{
  "clusters": [
    {
      "dim_id": "<该组所属维度 id>",
      "finding_ids": ["<本组包含的输入 finding id>"],
      "level": "错误 | 警告",
      "description": "<合并后一句话讲清这个根因>",
      "suggestion": "<合并后的统一修改建议>"
    }
  ]
}

# 约束

- 所有输入 id(${allIds})必须出现且仅出现一次,分布在各 cluster 的 \`finding_ids\` 里。
- \`finding_ids\` 同组的所有 finding 必须是**同一个 dim_id**。
- \`level\` 用精确中文(错误 / 警告),不要英文或别名。`;
}

function oneLine(s: string): string {
  // 截断:防恶意/超长 SKILL.md 内容原样 ×N 灌进 merge prompt(无界膨胀 + 注入面)。
  return s.replace(/\s+/g, ' ').replace(/"/g, "'").trim().slice(0, 300);
}

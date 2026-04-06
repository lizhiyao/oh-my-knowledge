import { createExecutor, DEFAULT_MODEL } from './runtime/index.js';
import type { Sample } from './types.js';

const SYSTEM_PROMPT = `你是一个评测用例生成器。你的任务是根据用户提供的 skill（系统提示词）内容，生成高质量的测试样本。

每个样本需包含以下字段：
- sample_id: 唯一标识，格式为 s001, s002, ...
- prompt: 用户会向使用此 skill 的 AI 提出的典型问题或指令
- context: 可选，附加上下文信息（如代码片段、文档段落等），仅在需要时提供
- rubric: 评分标准，描述一个好的回答应该具备什么特征（1-2 句话）
- assertions: 2-3 个断言检查，可选类型：
  - { "type": "contains", "value": "关键词", "weight": 1 }
  - { "type": "not_contains", "value": "不应出现的内容", "weight": 0.5 }
  - { "type": "regex", "pattern": "正则表达式", "weight": 1 }

要求：
1. 测试样本应覆盖 skill 的不同能力维度
2. prompt 要贴近真实用户的使用场景
3. rubric 要具体，不要泛泛而谈
4. assertions 要有区分度，能检测出有无 skill 的差异
5. 断言应检测 skill 文档中的具体细节（如特定参数名、配置值、工作流步骤），而非通用知识。
   避免使用 baseline 凭常识或搜索文件也能答对的断言（如 not_contains 通用错误写法）。
   优先使用 contains 检测文档独有的术语、参数组合或特定值

直接输出 JSON 数组，不要包含 markdown 代码块标记或其他内容。`;

interface GenerateSamplesOptions {
  skillContent: string;
  count?: number;
  model?: string;
  executorName?: string;
}

export async function generateSamples({ skillContent, count = 5, model = DEFAULT_MODEL, executorName = 'claude' }: GenerateSamplesOptions): Promise<{ samples: Sample[]; costUSD: number }> {
  const executor = createExecutor(executorName);

  const prompt = `以下是需要评测的 skill 内容：

${skillContent}

请根据这个 skill 生成 ${count} 个测试样本。直接输出 JSON 数组。`;

  const result = await executor({ model, system: SYSTEM_PROMPT, prompt });

  if (!result.ok) {
    throw new Error(`生成失败: ${result.error || 'unknown error'}`);
  }

  // Extract JSON from output (handle possible markdown code blocks)
  let jsonStr = result.output!.trim();
  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  }

  let samples: Sample[];
  try {
    samples = JSON.parse(jsonStr);
  } catch {
    throw new Error('生成的内容不是有效的 JSON，请重试');
  }

  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error('生成结果为空，请重试');
  }

  // Validate required fields
  for (const [i, s] of samples.entries()) {
    if (!s.sample_id) s.sample_id = `s${String(i + 1).padStart(3, '0')}`;
    if (!s.prompt) throw new Error(`samples[${i}] 缺少 prompt 字段`);
  }

  return { samples, costUSD: result.costUSD };
}

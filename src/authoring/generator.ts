import { createExecutor, DEFAULT_MODEL } from '../executors/index.js';
import type { Sample } from '../types/index.js';

const SYSTEM_PROMPT = `你是一个评测用例生成器。你的任务是根据用户提供的 skill（系统提示词）内容，生成高质量的评测用例。

每个用例需包含以下字段：
- sample_id: 唯一标识，格式为 s001, s002, ...
- prompt: 用户会向使用此 skill 的 AI 提出的典型问题或指令
- context: 可选，附加上下文信息（如代码片段、文档段落等），仅在需要时提供
- rubric: 评分标准，描述一个好的回答应该具备什么特征（1-2 句话）
- assertions: 3-5 个断言检查。**优先选能直接验证工具调用/流程的类型,把"LLM 文本输出"当兜底**:
  工具/流程类(强信号,首选):
  - { "type": "tool_input_contains", "value": "Bash:tag-list", "weight": 1 }
        ↑ 检查某 toolCall 的 input(JSON.stringify 后)包含子串。格式: "Tool:期望子串"。
        用于断言"LLM 调对了命令/参数"——这才是 skill 知识的真凭据。
  - { "type": "tool_output_contains", "value": "Read:DevAPI", "weight": 0.5 }
        ↑ 检查某工具返回(被 mock 的内容)的子串,格式同上。验证"LLM 看到了关键中间产物"。
  - { "type": "tools_called", "values": ["Bash", "Read"], "weight": 0.5 }
        ↑ 必须调过这些工具。
  - { "type": "tools_not_called", "values": ["searchWorkItem"], "weight": 0.5 }
        ↑ 不得调用某工具(典型场景:不要走错的 MCP / 旧接口)。
  - { "type": "mock_hit", "value": "Bash:2", "weight": 1 }
        ↑ 校验"驱动流程": sample.mocks 数组里第 N 条(1-based)是否被命中至少一次。
        例: mocks=[A,B,C](A=PROJECT 空 / B=WORKSPACE 命中 / C=search),
        用 mock_hit "Bash:2" 强制 LLM 必须走到第 2 步(WORKSPACE 兜底),否则失分。
        threshold 字段可选,默认 >=1。
  文本类(兜底,不要单用):
  - { "type": "contains", "value": "English keyword or code token", "weight": 1 }
        ↑ 只查 LLM 给用户的最终文本,**不查 toolCall**。命令名/参数大概率不出现在最终回答里,
        所以"LLM 是否调对工具"绝不要用 contains,要用 tool_input_contains。
  - { "type": "not_contains", "value": "...", "weight": 0.5 }
  - { "type": "regex", "pattern": "...", "weight": 1 }
- environment: 可选,对象。**评测环境的"已就绪"声明**,LLM 看到后跳过环境探测直接进工作流。
  字段:
    - cli_available: string[],已在 PATH 上的 CLI(如 ["node", "git", "code-host"])
    - files_available: string[],已存在的文件/脚本(如 ["~/.req-tool-api.json", "$SKILL_DIR/scripts/x.js"])
    - notes: string,自由文本兜底(如"DevAPI 凭证有效,工号 testuser001")
  原则:
    凡是 skill 跑起来需要的环境(凭证文件 / 业务 CLI / 自带脚本 / API token 等),
    都写到这里,而不是在 mock 里 mock 它们的探测命令。这让 mock 只关注业务调用本身。
- mocks: 可选,数组。该 sample 跑评测时拦截工具调用 + 返回 stub。**避免真调外部接口/CLI/MCP/写状态**。
  生成原则:
    1. **mocks 只覆盖业务调用,不覆盖环境探测** — 环境前置由 \`environment\` 字段声明,
       LLM 不会再做 Glob / find / which / test -f / Read 这些探测,所以也不需要 mock。
    2. **mock 数据要"驱动流程"而非"提前给答案"** — 这是关键:
       - 如果 skill 描述的工作流是多步的(A→B→C),mock 数据要**让最终答案只在最后一步出现**,
         前面的 mock 只能给出"推进到下一步必需的中间产物",不能直接揭示完整答案。
       - 反例(❌):第 1 步 mock 直接返回完整答案 → LLM 觉得"够了"跳过后续步骤,
         评测拿不到"是否走完合规流程"的信号。
       - 正例(✅):第 1 步 mock 返回空 / 局部 / 索引 ID → LLM 必须用这个中间产物去调下一步,
         一直走到最后一步才能拿到最终答案。
       - 例:req-tool 查标签工作流(PROJECT tag-list → WORKSPACE tag-list → tag-search):
         * 错的设计:PROJECT 直接返回 \`[{tagName:"Daily",count:99}]\` → LLM 跳过 WORKSPACE
         * 对的设计:PROJECT 返回 \`[]\`,WORKSPACE 返回 \`[{tagId:"W001",tagName:"Daily"}]\`,
           tag-search 用 \`W001\` 才返回最终工作项列表
    4. write 类调用(submit / create / push)mock 返回成功响应即可
    5. 不要 mock LLM 内部 think/text 行为,只 mock 外部副作用工具
  mock 项 schema:
    {
      "tool": "Bash" | "Read" | "Edit" | "Write" | "WebFetch" | "Grep" | "Glob",
      "match": {
        "file_path": "<absolute-or-~-prefixed path>",  // Read/Edit/Write
        "url": "<exact url>" or "url_glob": "<glob>",  // WebFetch
        "command_glob": "<glob>",                       // Bash 拦 mcporter / cli
        "input": { "<key>": "<value>" }                // generic deep-equal subset
      },
      "return": "<string>" or { "stdout": "...", "exit": 0 },
      "return_seq": [<r1>, <r2>]   // optional 状态机:同 mock 多次命中按序返回
    }
  command_glob 示例:
    - "mcporter call * --tool find_drm_value*"   (拦 MCP find_drm_value 调用)
    - "code-host pr show *"                         (拦 code-host CLI)
    - "git push *"                                (拦 git push)

要求：
1. 评测用例应覆盖 skill 的不同能力维度
2. prompt 要贴近真实用户的使用场景
3. rubric 要具体，不要泛泛而谈
4. assertions 要有区分度，能检测出有无 skill 的差异
5. assertions 的 value / pattern / values / reference 必须使用英文、数字或代码 token，不要使用中文关键词。
6. 断言应检测 skill 文档中的具体细节（如特定参数名、配置值、工作流步骤），而非通用知识。
   避免使用 baseline 凭常识或搜索文件也能答对的断言（如 not_contains 通用错误写法）。
   **断言类型选择口诀**:
   - 测"LLM 调了哪个工具/什么命令" → 用 tool_input_contains 或 tools_called(不要用 contains)
   - 测"LLM 走完了流程的某一步" → 用 mock_hit(配合 sample.mocks 的"驱动流程"设计,见下文)
   - 测"LLM 没用错误的工具" → 用 tools_not_called
   - 测"LLM 最终回答提到了某事实/数值" → 用 contains(只在最终文本上有意义的场景用)
   优先组合使用,典型 sample 通常有 2 条 tool_input_contains + 1 条 tools_not_called + 1 条 contains。
7. 如果 skill 涉及外部调用(MCP/CLI/HTTP/文件读),**必须**为本 sample 生成 mocks 数组,
   保证评测时 0 真调底层。query 类返回贴近真实 schema 的示例数据,write 类返回 success。

可选元数据字段如能判断顺便填，无法判断时省略整个字段即可）：
- capability: string[] — 该用例覆盖的能力维度，如 ["api-selection", "error-diagnosis"]
- difficulty: "easy" | "medium" | "hard" — 难度等级
- construct: string — 用例测的 construct 类型，建议值 "necessity"（测知识必要性）/ "quality"（测 skill 写得好不好）/ "capability"（测某具体能力）

直接输出 JSON 数组，不要包含 markdown 代码块标记或其他内容。`;

interface GenerateSamplesOptions {
  skillContent: string;
  count?: number;
  model?: string;
  executorName?: string;
  /**
   * 自然语言描述用户希望重点覆盖的场景。会作为额外约束追加到 prompt 末尾，
   * 优先于"自由发挥"的多样性。空串 / undefined 表示不施加额外约束。
   */
  focus?: string;
}

/**
 * 拼出送给 LLM 的 user prompt。抽出来便于单测验证 focus 是否真的注入了。
 */
export function buildSamplesPrompt({ skillContent, count, focus }: { skillContent: string; count: number; focus?: string }): string {
  const focusBlock = focus && focus.trim()
    ? `\n\n额外要求（用户指定的场景重点）：\n${focus.trim()}\n生成的用例必须优先覆盖以上场景，再在剩余配额内补充其它能力维度。`
    : '';
  return `以下是需要评测的 skill 内容：

${skillContent}

请根据这个 skill 生成 ${count} 个评测用例。直接输出 JSON 数组。${focusBlock}`;
}

export async function generateSamples({ skillContent, count = 5, model = DEFAULT_MODEL, executorName = 'claude', focus }: GenerateSamplesOptions): Promise<{ samples: Sample[]; costUSD: number }> {
  const executor = createExecutor(executorName);

  const prompt = buildSamplesPrompt({ skillContent, count, focus });

  const result = await executor({ model, system: SYSTEM_PROMPT, prompt });

  if (!result.ok) {
    throw new Error(`generation failed: ${result.error || 'unknown error'}`);
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
    throw new Error('generated content is not valid JSON, please retry');
  }

  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error('generated result is empty, please retry');
  }

  // Validate required fields + sanitize  metadata enums *at generator boundary*
  // (see sanitizeGeneratedSamples).
  const { stripped } = sanitizeGeneratedSamples(samples);
  if (stripped.length > 0) {
    process.stderr.write(
      `[omk improve samples] LLM-output 含 ${stripped.length} 个非法元数据字段，已剥离避免污染：\n  - ${stripped.join('\n  - ')}\n`,
    );
  }

  return { samples, costUSD: result.costUSD };
}

/**
 * Validate + sanitize LLM-generated samples at generator boundary.
 *
 * Why this exists:
 *   LLM-output garbage (`capability: 'string'` / `difficulty: 'Easy'` /
 *   `provenance: 'invalid'`) shouldn't get persisted to disk and trip
 *   `loadSamples` on the NEXT run/diagnose. We strip invalid metadata fields
 *   with a stderr warn (don't throw — valid required fields should still
 *   produce usable samples).
 *
 * Behavior:
 *   - `sample_id` defaulted if missing
 *   - `prompt` missing → throw (required)
 *   - `capability` not string[] → strip
 *   - `difficulty` not in enum → strip
 *   - `construct` not non-empty string → strip
 *   - `provenance` not in enum → strip,then auto-stamp 'llm-generated'
 *
 * Mutates the samples array in-place (matches generator's existing style).
 * Returns `{ stripped: string[] }` for warning aggregation + tests.
 */
export function sanitizeGeneratedSamples(samples: Sample[]): { stripped: string[] } {
  const VALID_DIFFICULTY = new Set(['easy', 'medium', 'hard']);
  const VALID_PROVENANCE = new Set(['human', 'llm-generated', 'production-trace']);
  const stripped: string[] = [];
  for (const [i, s] of samples.entries()) {
    // sample_id / prompt 必须是 non-empty string。LLM 偶尔返回 number / null,
    // 当前若漏校验下游 loadSamples 会拒掉整个文件 — 在 generator boundary 修掉。
    if (typeof s.sample_id !== 'string' || s.sample_id.length === 0) {
      s.sample_id = `s${String(i + 1).padStart(3, '0')}`;
    }
    if (typeof s.prompt !== 'string' || s.prompt.length === 0) {
      throw new Error(`samples[${i}] missing or invalid required prompt field (got ${typeof s.prompt})`);
    }

    if (s.capability !== undefined) {
      if (!Array.isArray(s.capability) || !s.capability.every((c) => typeof c === 'string' && c.length > 0)) {
        stripped.push(`samples[${i}].capability (${typeof s.capability})`);
        delete (s as { capability?: unknown }).capability;
      }
    }
    if (s.difficulty !== undefined && !VALID_DIFFICULTY.has(s.difficulty as string)) {
      stripped.push(`samples[${i}].difficulty=${JSON.stringify(s.difficulty)}`);
      delete (s as { difficulty?: unknown }).difficulty;
    }
    if (s.construct !== undefined && (typeof s.construct !== 'string' || !s.construct)) {
      stripped.push(`samples[${i}].construct (${typeof s.construct})`);
      delete (s as { construct?: unknown }).construct;
    }
    if (s.provenance !== undefined && !VALID_PROVENANCE.has(s.provenance as string)) {
      stripped.push(`samples[${i}].provenance=${JSON.stringify(s.provenance)}`);
      delete (s as { provenance?: unknown }).provenance;
    }
    // After stripping invalid provenance, auto-stamp the generator's authority value.
    if (!s.provenance) s.provenance = 'llm-generated';

    // environment 校验:必须是对象,内部字段要么是 string[] 要么是 string。
    // 非法字段 strip 掉,避免 runtime 注入时炸 prompt。
    if (s.environment !== undefined) {
      if (typeof s.environment !== 'object' || s.environment === null || Array.isArray(s.environment)) {
        stripped.push(`samples[${i}].environment (${typeof s.environment})`);
        delete (s as { environment?: unknown }).environment;
      } else {
        const env = s.environment as Record<string, unknown>;
        if (env.cli_available !== undefined && (!Array.isArray(env.cli_available) || !env.cli_available.every((x) => typeof x === 'string' && x.length > 0))) {
          stripped.push(`samples[${i}].environment.cli_available (${typeof env.cli_available})`);
          delete env.cli_available;
        }
        if (env.files_available !== undefined && (!Array.isArray(env.files_available) || !env.files_available.every((x) => typeof x === 'string' && x.length > 0))) {
          stripped.push(`samples[${i}].environment.files_available (${typeof env.files_available})`);
          delete env.files_available;
        }
        if (env.notes !== undefined && (typeof env.notes !== 'string')) {
          stripped.push(`samples[${i}].environment.notes (${typeof env.notes})`);
          delete env.notes;
        }
        // 如果所有子字段都没了,整个 environment 也删掉
        if (Object.keys(env).length === 0) {
          delete (s as { environment?: unknown }).environment;
        }
      }
    }

    // mocks 校验:必须是数组,每项必须有 tool(string)+ 至少一种 return。
    // 非法的 strip 掉,避免 runtime 装 hook 时炸。
    if (s.mocks !== undefined) {
      if (!Array.isArray(s.mocks)) {
        stripped.push(`samples[${i}].mocks (${typeof s.mocks})`);
        delete (s as { mocks?: unknown }).mocks;
      } else {
        const validMocks: unknown[] = [];
        for (let j = 0; j < s.mocks.length; j++) {
          const m = s.mocks[j] as unknown as Record<string, unknown>;
          if (typeof m?.tool !== 'string' || m.tool.length === 0) {
            stripped.push(`samples[${i}].mocks[${j}].tool (missing/invalid)`);
            continue;
          }
          if (m.return === undefined && m.return_file === undefined && m.return_seq === undefined) {
            stripped.push(`samples[${i}].mocks[${j}] (no return/return_file/return_seq)`);
            continue;
          }
          validMocks.push(m);
        }
        if (validMocks.length > 0) (s as Record<string, unknown>).mocks = validMocks;
        else delete (s as { mocks?: unknown }).mocks;
      }
    }
  }
  return { stripped };
}

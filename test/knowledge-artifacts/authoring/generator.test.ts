import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  buildSamplesFromTracesPrompt,
  buildSamplesPrompt,
  generateSamples,
  generateSamplesFromTraces,
  sampleGenerationUsesMocks,
  sanitizeGeneratedSamples,
  stratifyTraceSignals,
} from '../../../src/knowledge-artifacts/authoring/generator.js';
import type { ExecutorFn } from '../../../src/executors/contracts/ports.js';
import type { Sample } from '../../../src/eval-workflows/inputs/contracts/sample.js';

describe('generateSamples', () => {
  it('is a function', () => {
    assert.equal(typeof generateSamples, 'function');
  });

  it('throws on invalid executor (script not found)', async () => {
    await assert.rejects(
      () => generateSamples({ skillContent: 'test', count: 1, model: 'test-model', executorName: 'nonexistent' }),
      /ENOENT|failed/,
    );
  });

  it('forces Codex generation into mockless mode and strips ignored mock output', async () => {
    let capturedSystem = '';
    let capturedPrompt = '';
    const executor: ExecutorFn = async (input) => {
      capturedSystem = input.system ?? '';
      capturedPrompt = input.prompt;
      return {
        ok: true,
        output: JSON.stringify([{
          sample_id: 's001',
          prompt: 'review the integration',
          rubric: 'explain the correct result',
          environment: { files_available: ['app.js'] },
          mocks: [{ tool: 'Read', return: 'fixture' }],
          mocksStrict: true,
          assertions: [
            { type: 'mock_hit', value: 'Read:1' },
            { type: 'tools_called', values: ['Read'] },
            { type: 'tools_not_called', values: ['Write'] },
            { type: 'contains', value: 'Sentry.init' },
          ],
        }]),
        durationMs: 1,
        durationApiMs: 1,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUSD: 0,
        stopReason: 'end_turn',
        numTurns: 1,
      };
    };

    const result = await generateSamples({
      skillContent: 'Use Read only when a fixture exists.',
      count: 1,
      model: 'test',
      executorName: 'codex',
      executor,
    });

    assert.match(capturedSystem, /目标执行器能力约束（最高优先级）/);
    assert.match(capturedPrompt, /不要生成 mocks 和 mocksStrict/);
    assert.equal(result.samples[0].mocks, undefined);
    assert.equal(result.samples[0].mocksStrict, undefined);
    assert.equal(result.samples[0].environment, undefined);
    assert.match(result.samples[0].context ?? '', /题设引用路径（未物化）：app\.js/);
    assert.deepEqual(
      result.samples[0].assertions?.map((assertion) => assertion.type),
      ['tools_not_called', 'contains'],
    );
  });
});

describe('buildSamplesFromTracesPrompt', () => {
  const items = [
    {
      skillName: 'prd', signalType: 'failed_search', signalSubtype: 'no_results', severity: 'high', occurrences: 3,
      evidence: { tool: 'Grep', query: 'auth flow', outputSnippet: 'No matches found' },
      messageWindow: { before: [], event: [{ role: 'assistant', snippet: 'searching the repo...', messageIndex: 1 }], after: [], resolutionAfter: 'unresolved' },
    },
    {
      skillName: 'prd', signalType: 'hedging', signalSubtype: 'uncertain', severity: 'medium', occurrences: 1,
      evidence: {},
    },
  ] as unknown as Parameters<typeof buildSamplesFromTracesPrompt>[0];

  it('renders each signal with its evidence, skill, and message window', () => {
    const prompt = buildSamplesFromTracesPrompt(items);
    assert.match(prompt, /信号 1/);
    assert.match(prompt, /信号 2/);
    assert.match(prompt, /failed_search/);
    assert.match(prompt, /Grep/);
    assert.match(prompt, /auth flow/);
    assert.match(prompt, /searching the repo/);
    assert.match(prompt, /skill: prd/);
  });

  it('frames the input as production traces, not a skill', () => {
    const prompt = buildSamplesFromTracesPrompt(items);
    assert.match(prompt, /trace/);
    assert.match(prompt, /生产会话/);
    assert.match(prompt, /不是 skill/);
  });

  it('falls back gracefully when a signal has no structured evidence', () => {
    const prompt = buildSamplesFromTracesPrompt(items);
    assert.match(prompt, /\(无结构化证据\)/);
  });

  it('honors an explicit count, else instructs proportional-to-frequency allocation', () => {
    assert.match(buildSamplesFromTracesPrompt(items, 8), /共生成约 8 条/);
    assert.match(buildSamplesFromTracesPrompt(items), /按各信号「占比」分配/);
    // 频次占比写进每个信号段(signal 1 出现 3 次 / 共 4 → 75%）。
    assert.match(buildSamplesFromTracesPrompt(items), /占比 75%/);
  });

  it('adds a mockless override for trace drafts when requested', () => {
    const prompt = buildSamplesFromTracesPrompt(items, undefined, { noMock: true });
    assert.match(prompt, /不要生成 mocks/);
    assert.match(prompt, /trace 证据写入 context 和 rubric/);
  });
});

describe('stratifyTraceSignals', () => {
  it('ranks by occurrences desc and annotates each with its share of the total', () => {
    const items = [
      { skillName: 's', signalType: 'hedging', signalSubtype: 'uncertain', severity: 'low', occurrences: 1, evidence: {} },
      { skillName: 's', signalType: 'failed_search', signalSubtype: 'no_results', severity: 'high', occurrences: 3, evidence: { tool: 'Grep' } },
    ] as unknown as Parameters<typeof stratifyTraceSignals>[0];
    const out = stratifyTraceSignals(items);
    assert.equal(out[0].signalType, 'failed_search'); // 高频在前
    assert.equal(out[0].occurrences, 3);
    assert.equal(Number(out[0].weight.toFixed(2)), 0.75);
    assert.equal(Number(out[1].weight.toFixed(2)), 0.25);
  });

  it('does NOT re-merge same-shape signals from different skills (inbox already deduped by skill+cwd)', () => {
    // 同 type/subtype/evidence 但不同 skill —— inbox 已按 skill+cwd 分开聚合,这里不能再揉成一条,
    // 否则跨 skill 的 occurrences 会被错误归因到第一个 skill 上。
    const items = [
      { skillName: 'skill-a', signalType: 'failed_search', signalSubtype: 'no_results', severity: 'high', occurrences: 2, evidence: { tool: 'Grep', query: 'x' } },
      { skillName: 'skill-b', signalType: 'failed_search', signalSubtype: 'no_results', severity: 'high', occurrences: 5, evidence: { tool: 'Grep', query: 'x' } },
    ] as unknown as Parameters<typeof stratifyTraceSignals>[0];
    const out = stratifyTraceSignals(items);
    assert.equal(out.length, 2);
    // 各自保留自己的 skill 与 occurrences,不串台。
    assert.equal(out[0].skillName, 'skill-b'); // 高频在前
    assert.equal(out[0].occurrences, 5);
    assert.equal(out[1].skillName, 'skill-a');
    assert.equal(out[1].occurrences, 2);
    assert.equal(Number(out[0].weight.toFixed(3)), 0.714);
  });

  it('does not mutate the caller input', () => {
    const items = [
      { skillName: 's', signalType: 'failed_search', signalSubtype: 'no_results', severity: 'high', occurrences: 3, evidence: {} },
    ] as unknown as Parameters<typeof stratifyTraceSignals>[0];
    stratifyTraceSignals(items);
    assert.equal((items[0] as { weight?: number }).weight, undefined);
  });
});

describe('generateSamplesFromTraces', () => {
  const oneItem = [{
    skillName: 'prd', signalType: 'failed_search', signalSubtype: 'no_results', severity: 'high', occurrences: 1,
    evidence: { tool: 'Grep', query: 'x' },
  }] as unknown as Parameters<typeof generateSamplesFromTraces>[0]['items'];

  const mockExec = (output: string): NonNullable<Parameters<typeof generateSamplesFromTraces>[0]['executor']> =>
    (async () => ({ ok: true, output, costUSD: 0.01 })) as unknown as NonNullable<Parameters<typeof generateSamplesFromTraces>[0]['executor']>;

  it('returns empty without invoking an executor when there are no signals', async () => {
    const r = await generateSamplesFromTraces({ items: [], model: 'test-model' });
    assert.deepEqual(r, { samples: [], costUSD: 0 });
  });

  it('treats an empty array from the model as a valid 0-result, not a failure', async () => {
    // The prompt tells the model to skip noise / unreproducible signals; `[]` is then a
    // legitimate conservative outcome and must not throw or retry-to-failure.
    const r = await generateSamplesFromTraces({ items: oneItem, model: 'test-model', executor: mockExec('[]') });
    assert.deepEqual(r.samples, []);
  });

  it('stamps production-trace provenance on generated samples', async () => {
    const r = await generateSamplesFromTraces({
      items: oneItem,
      model: 'test-model',
      executor: mockExec(JSON.stringify([{ sample_id: 'trace-1', prompt: 'reproduce the failed search for x', rubric: 'should locate the file' }])),
    });
    assert.ok(r.samples.length >= 1);
    assert.ok(r.samples.every((s) => s.provenance === 'production-trace'));
  });
});

describe('buildSamplesPrompt', () => {
  it('embeds skill content and count', () => {
    const prompt = buildSamplesPrompt({ skillContent: '# my skill', count: 7 });
    assert.ok(prompt.includes('# my skill'));
    assert.ok(prompt.includes('生成 7 个评测用例'));
  });

  it('omits explicit count when count is undefined (LLM auto-decides)', () => {
    const prompt = buildSamplesPrompt({ skillContent: 's', count: undefined });
    // 不应包含具体数字 + "个评测用例"的强制句式
    assert.ok(!/生成 \d+ 个评测用例/.test(prompt), 'should not contain "生成 N 个评测用例"');
    // 应明确告诉 LLM 自行判断
    assert.ok(prompt.includes('自行判断'), 'should ask LLM to auto-decide count');
  });

  it('omits the focus block when focus is undefined', () => {
    const prompt = buildSamplesPrompt({ skillContent: 's', count: 3 });
    assert.ok(!prompt.includes('额外要求'));
  });

  it('omits the focus block when focus is whitespace-only', () => {
    const prompt = buildSamplesPrompt({ skillContent: 's', count: 3, focus: '   \n  ' });
    assert.ok(!prompt.includes('额外要求'));
  });

  it('injects focus text into the prompt when provided', () => {
    const focus = '重点覆盖 PROJECT 空 → WORKSPACE 兜底的多步流程';
    const prompt = buildSamplesPrompt({ skillContent: 's', count: 5, focus });
    assert.ok(prompt.includes('额外要求'), 'should include the focus header');
    assert.ok(prompt.includes(focus), 'should include the focus body verbatim');
    // focus 须排在 count 指令之后,作为追加约束(避免 LLM 把 focus 当主指令而忽略 count)
    assert.ok(prompt.indexOf('生成 5 个评测用例') < prompt.indexOf('额外要求'));
  });

  it('trims surrounding whitespace from focus', () => {
    const prompt = buildSamplesPrompt({ skillContent: 's', count: 3, focus: '  scenario X  \n' });
    assert.ok(prompt.includes('scenario X'));
    assert.ok(!prompt.includes('  scenario X  '));
  });

  it('disables mocks automatically for unsupported executors', () => {
    assert.equal(sampleGenerationUsesMocks('claude'), true);
    assert.equal(sampleGenerationUsesMocks('codex'), false);
    assert.equal(sampleGenerationUsesMocks('claude', true), false);
  });
});

// sanitize boundary (UltraReview Bug #1 fix)
describe('sanitizeGeneratedSamples', () => {
  it('default-stamps provenance: "llm-generated" when missing', () => {
    const samples: Sample[] = [{ sample_id: 's1', prompt: 'p' }];
    sanitizeGeneratedSamples(samples);
    assert.equal(samples[0].provenance, 'llm-generated');
  });

  it('preserves valid LLM-output provenance value', () => {
    const samples: Sample[] = [{ sample_id: 's1', prompt: 'p', provenance: 'human' }];
    sanitizeGeneratedSamples(samples);
    assert.equal(samples[0].provenance, 'human');
  });

  it('strips invalid provenance enum + auto-stamps llm-generated', () => {
    // 之前的 bug: `if (!s.provenance)` 只看 truthy, 'invalid' 会保留 → 写盘 → 下次 loadSamples reject
    const samples: Sample[] = [{ sample_id: 's1', prompt: 'p', provenance: 'invalid' as Sample['provenance'] }];
    const { stripped } = sanitizeGeneratedSamples(samples);
    assert.equal(samples[0].provenance, 'llm-generated', 'invalid provenance must be replaced');
    assert.ok(stripped.some((s) => s.includes('provenance')));
  });

  it('strips invalid difficulty enum', () => {
    const samples: Sample[] = [{ sample_id: 's1', prompt: 'p', difficulty: 'Easy' as Sample['difficulty'] }];
    const { stripped } = sanitizeGeneratedSamples(samples);
    assert.equal(samples[0].difficulty, undefined, 'invalid difficulty must be deleted');
    assert.ok(stripped.some((s) => s.includes('difficulty')));
  });

  it('strips capability when not string[]', () => {
    const samples: Sample[] = [{ sample_id: 's1', prompt: 'p', capability: 'single' as unknown as string[] }];
    const { stripped } = sanitizeGeneratedSamples(samples);
    assert.equal(samples[0].capability, undefined);
    assert.ok(stripped.some((s) => s.includes('capability')));
  });

  it('strips capability when array contains non-strings', () => {
    const samples: Sample[] = [{ sample_id: 's1', prompt: 'p', capability: ['ok', 123] as unknown as string[] }];
    sanitizeGeneratedSamples(samples);
    assert.equal(samples[0].capability, undefined);
  });

  it('preserves valid capability + difficulty + construct + provenance', () => {
    const samples: Sample[] = [{
      sample_id: 's1', prompt: 'p',
      capability: ['api-selection'], difficulty: 'medium', construct: 'capability', provenance: 'llm-generated',
    }];
    const { stripped } = sanitizeGeneratedSamples(samples);
    assert.deepEqual(samples[0].capability, ['api-selection']);
    assert.equal(samples[0].difficulty, 'medium');
    assert.equal(samples[0].construct, 'capability');
    assert.equal(stripped.length, 0);
  });

  it('default sample_id when missing', () => {
    const samples: Sample[] = [{ prompt: 'p' } as Sample];
    sanitizeGeneratedSamples(samples);
    assert.equal(samples[0].sample_id, 's001');
  });

  it('strips tools_not_called with empty values (noise assertion)', () => {
    const samples: Sample[] = [{
      sample_id: 's1', prompt: 'p',
      assertions: [
        { type: 'tool_input_contains', value: 'Bash:foo', weight: 1 },
        { type: 'tools_not_called', values: [], weight: 0 },
      ],
    }];
    const { stripped } = sanitizeGeneratedSamples(samples);
    assert.equal(samples[0].assertions?.length, 1, 'empty tools_not_called dropped');
    assert.equal(samples[0].assertions?.[0].type, 'tool_input_contains');
    assert.ok(stripped.some((s) => s.includes('tools_not_called')), 'should warn');
  });

  it('strips tools_called with non-string entries', () => {
    const samples: Sample[] = [{
      sample_id: 's1', prompt: 'p',
      assertions: [
        { type: 'tools_called', values: ['Bash', '', null as unknown as string], weight: 1 },
      ],
    }];
    sanitizeGeneratedSamples(samples);
    assert.equal(samples[0].assertions, undefined, 'all assertions stripped → undefined');
  });

  // Rule A: text-class value content guard (CJK / fullwidth / whitespace / length).
  it('rule A: strips contains with CJK value (LLM-output literal Chinese unstable)', () => {
    const samples: Sample[] = [{
      sample_id: 's1', prompt: 'p',
      assertions: [
        { type: 'contains', value: '留档', weight: 1 },
        { type: 'contains', value: 'ECONNREFUSED', weight: 1 },
      ],
    }];
    const { stripped } = sanitizeGeneratedSamples(samples);
    assert.equal(samples[0].assertions?.length, 1, 'only ASCII token kept');
    assert.equal(samples[0].assertions?.[0].value, 'ECONNREFUSED');
    assert.ok(stripped.some((s) => s.includes('留档')), 'warn about CJK value');
  });

  it('rule A: strips contains with fullwidth bracket "【...】"', () => {
    const samples: Sample[] = [{
      sample_id: 's1', prompt: 'p',
      assertions: [{ type: 'contains', value: '【需求文档】', weight: 1 }],
    }];
    const { stripped } = sanitizeGeneratedSamples(samples);
    assert.equal(samples[0].assertions, undefined, 'all assertions stripped');
    assert.ok(stripped.some((s) => /[全角中文]/.test(s) || s.includes('需求文档')));
  });

  it('rule A: strips contains_any whose any entry violates value rule', () => {
    const samples: Sample[] = [{
      sample_id: 's1', prompt: 'p',
      assertions: [
        // 第一项 ASCII OK，第二项中文 → 整条挂(短路即可,因为该断言语义不能"部分容忍")
        { type: 'contains_any', values: ['ECONNRESET', '连接重置'], weight: 1 },
      ],
    }];
    const { stripped } = sanitizeGeneratedSamples(samples);
    assert.equal(samples[0].assertions, undefined);
    assert.ok(stripped.some((s) => s.includes('contains_any')));
  });

  it('rule A: strips contains with internal whitespace (phrase, not token)', () => {
    const samples: Sample[] = [{
      sample_id: 's1', prompt: 'p',
      assertions: [
        { type: 'contains', value: 'git push origin', weight: 1 },     // phrase → strip
        { type: 'contains', value: 'git-push-origin', weight: 1 },     // hyphenated token → keep
      ],
    }];
    sanitizeGeneratedSamples(samples);
    assert.equal(samples[0].assertions?.length, 1);
    assert.equal(samples[0].assertions?.[0].value, 'git-push-origin');
  });

  it('rule A: strips regex pattern containing CJK characters', () => {
    const samples: Sample[] = [{
      sample_id: 's1', prompt: 'p',
      assertions: [{ type: 'regex', pattern: '风险等级:\\s*(高|中|低)', weight: 1 }],
    }];
    const { stripped } = sanitizeGeneratedSamples(samples);
    assert.equal(samples[0].assertions, undefined);
    assert.ok(stripped.some((s) => s.toLowerCase().includes('regex')));
  });

  // Rule B: positive tool-bound assertion's tool name must be in SKILL.md.
  it('rule B: strips tool_input_contains whose tool name not in SKILL.md', () => {
    const samples: Sample[] = [{
      sample_id: 's1', prompt: 'p',
      assertions: [
        { type: 'tool_input_contains', value: 'WebFetch:irk5ik/kg7h1z', weight: 1 },
        { type: 'tool_input_contains', value: 'Read:checks/x.md', weight: 1 },
      ],
    }];
    // SKILL.md 提到 Read 但没提 WebFetch
    const skill = 'Step 1: Read the requirement spec from checks/requirement.md ...';
    const { stripped } = sanitizeGeneratedSamples(samples, { skillContent: skill });
    assert.equal(samples[0].assertions?.length, 1);
    assert.equal(samples[0].assertions?.[0].value, 'Read:checks/x.md');
    assert.ok(stripped.some((s) => s.includes('WebFetch')), 'warn about hallucinated tool');
  });

  it('rule B: keeps tool_input_contains when tool name appears in SKILL.md (case-insensitive)', () => {
    const samples: Sample[] = [{
      sample_id: 's1', prompt: 'p',
      assertions: [
        { type: 'tool_input_contains', value: 'Bash:git push', weight: 1 },
        { type: 'tool_input_contains', value: 'webfetch:https://example.com', weight: 1 },
      ],
    }];
    const skill = '## Tools\n- bash for shell\n- WebFetch for HTTP GET\nStep: invoke WebFetch on the docs URL.';
    sanitizeGeneratedSamples(samples, { skillContent: skill });
    assert.equal(samples[0].assertions?.length, 2, 'both tools mentioned in skill (case-insensitive match)');
  });

  it('rule B: tool_input_not_contains is exempt (forbidden tools need not be in SKILL.md)', () => {
    const samples: Sample[] = [{
      sample_id: 's1', prompt: 'p',
      assertions: [
        // git-push-with-force is a forbidden action, "--force" / "git push --force"
        // tool may not be mentioned in the doc even though the negative-rule sample
        // wants to prove the LLM never invoked it.
        { type: 'tool_input_not_contains', value: 'Bash:--force', weight: 1 },
        // Read 也不需要在 SKILL.md 出现因为这是"不该 read 某文件"的负向断言
        { type: 'tool_input_not_contains', value: 'CustomMcpTool:dangerous-op', weight: 1 },
      ],
    }];
    const skill = '# Skill\nDescription without mentioning Bash or CustomMcpTool by name.';
    sanitizeGeneratedSamples(samples, { skillContent: skill });
    assert.equal(samples[0].assertions?.length, 2, 'negative variants exempt from rule B');
  });

  it('rule B: when skillContent omitted, rule B silently passes (loader path)', () => {
    const samples: Sample[] = [{
      sample_id: 's1', prompt: 'p',
      assertions: [{ type: 'tool_input_contains', value: 'Mystery:foo', weight: 1 }],
    }];
    sanitizeGeneratedSamples(samples /* no opts */);
    assert.equal(samples[0].assertions?.length, 1, 'no skill content → rule B inert');
  });

  it('rule A: tool_input_contains/not_contains are NOT subject to text-value CJK rule', () => {
    // tool_input_(not_)contains 的 value 是 "Tool:needle" 格式,needle 部分可能本就该是
    // 字面 token(命令名 / flag / 路径片段),不走 TEXT_VALUE_TYPES 的 ASCII-token 校验。
    // 走的是规则 B 的"Tool 名是否在 SKILL.md"+ 已有的"Tool:needle 格式"校验。
    const samples: Sample[] = [{
      sample_id: 's1', prompt: 'p',
      assertions: [
        { type: 'tool_input_contains', value: 'Bash:git stash', weight: 1 },   // needle 含空格 OK
      ],
    }];
    sanitizeGeneratedSamples(samples, { skillContent: '## flow\nrun Bash: git stash before pull' });
    assert.equal(samples[0].assertions?.length, 1);
  });

  it('strips tool_input_not_contains with bare needle (no Tool: prefix)', () => {
    const samples: Sample[] = [{
      sample_id: 's1', prompt: 'p',
      assertions: [
        { type: 'tool_input_contains', value: 'Bash:foo', weight: 1 },
        { type: 'tool_input_not_contains', value: '--force', weight: 0.5 },
        { type: 'tool_input_contains', value: 'Bash:', weight: 0.5 },
      ],
    }];
    const { stripped } = sanitizeGeneratedSamples(samples);
    assert.equal(samples[0].assertions?.length, 1, 'only valid Tool:needle kept');
    assert.equal(samples[0].assertions?.[0].value, 'Bash:foo');
    assert.ok(stripped.some((s) => s.includes('--force')), 'should warn about bare needle');
  });

  it('auto-sets mocksStrict=true when mocks exist but mocksStrict missing', () => {
    const samples: Sample[] = [{
      sample_id: 's1',
      prompt: 'p',
      mocks: [{ tool: 'Bash', match: { command_glob: '*foo*' }, return: 'ok' }],
    }];
    sanitizeGeneratedSamples(samples);
    assert.equal(samples[0].mocksStrict, true, 'mocksStrict should default to true when mocks present');
  });

  it('preserves explicit mocksStrict=false (escape hatch)', () => {
    const samples: Sample[] = [{
      sample_id: 's1',
      prompt: 'p',
      mocks: [{ tool: 'Bash', match: { command_glob: '*foo*' }, return: 'ok' }],
      mocksStrict: false,
    }];
    sanitizeGeneratedSamples(samples);
    assert.equal(samples[0].mocksStrict, false, 'explicit false must be preserved');
  });

  it('does not set mocksStrict when sample has no mocks', () => {
    const samples: Sample[] = [{ sample_id: 's1', prompt: 'p' }];
    sanitizeGeneratedSamples(samples);
    assert.equal(samples[0].mocksStrict, undefined);
  });

  it('mockless mode removes positive tool evidence recursively but keeps safety negatives', () => {
    const samples: Sample[] = [{
      sample_id: 's1',
      prompt: 'p',
      environment: {
        cli_available: ['node'],
        files_available: ['app.js'],
      },
      mocks: [{ tool: 'Read', return: 'fixture' }],
      mocksStrict: true,
      assertions: [{
        type: 'assert-set',
        mode: 'all',
        children: [
          { type: 'mock_hit', value: 'Read:1' },
          { type: 'tools_not_called', values: ['Write'] },
        ],
      }],
    }];

    const { stripped } = sanitizeGeneratedSamples(samples, { mockless: true });
    assert.equal(samples[0].mocks, undefined);
    assert.equal(samples[0].mocksStrict, undefined);
    assert.equal(samples[0].environment, undefined);
    assert.deepEqual(samples[0].assertions, [{
      type: 'assert-set',
      mode: 'all',
      children: [{ type: 'tools_not_called', values: ['Write'] }],
    }]);
    assert.ok(stripped.some((item) => item.includes('mock_hit')));
    assert.ok(stripped.some((item) => item.includes('未物化')));
  });

  it('removes mock_hit assertions that do not reference a real per-tool mock ordinal', () => {
    const samples: Sample[] = [{
      sample_id: 's1',
      prompt: 'p',
      mocks: [
        { tool: 'Read', return: 'one' },
        { tool: 'Bash', return: 'two' },
        { tool: 'Read', return: 'three' },
      ],
      assertions: [{
        type: 'assert-set',
        mode: 'all',
        children: [
          { type: 'mock_hit', value: 'Read:2' },
          { type: 'mock_hit', value: 'Bash:2' },
        ],
      }],
    }];

    const { stripped } = sanitizeGeneratedSamples(samples);
    assert.deepEqual(samples[0].assertions, [{
      type: 'assert-set',
      mode: 'all',
      children: [{ type: 'mock_hit', value: 'Read:2' }],
    }]);
    assert.ok(stripped.some((item) => item.includes('Bash:2')));
  });

  it('preserves valid tripwire boolean', () => {
    const samples: Sample[] = [{ sample_id: 's1', prompt: 'p', tripwire: true }];
    sanitizeGeneratedSamples(samples);
    assert.equal(samples[0].tripwire, true);
  });

  it('strips non-boolean tripwire (LLM 偶尔返回 "true" 字符串)', () => {
    const samples: Sample[] = [{ sample_id: 's1', prompt: 'p', tripwire: 'true' as unknown as boolean }];
    const { stripped } = sanitizeGeneratedSamples(samples);
    assert.equal(samples[0].tripwire, undefined);
    assert.ok(stripped.some((s) => s.includes('tripwire')));
  });

  it('throws on missing prompt(required field)', () => {
    const samples: Sample[] = [{ sample_id: 's1' } as Sample];
    assert.throws(() => sanitizeGeneratedSamples(samples), /missing or invalid required prompt field/);
  });

  it('throws on non-string prompt(LLM 偶尔返回 number / null)', () => {
    const samples: Sample[] = [{ sample_id: 's1', prompt: 456 as unknown as string }];
    assert.throws(() => sanitizeGeneratedSamples(samples), /missing or invalid required prompt field.*number/);
  });

  it('default sample_id when type is non-string(LLM 返回 number)', () => {
    // Bug #2:写盘后下游 loadSamples 会 reject 整文件 — generator boundary 应规范化
    const samples: Sample[] = [{ sample_id: 123 as unknown as string, prompt: 'p' }];
    sanitizeGeneratedSamples(samples);
    assert.equal(samples[0].sample_id, 's001', 'non-string sample_id should be replaced with default');
  });

  it('default sample_id when empty string', () => {
    const samples: Sample[] = [{ sample_id: '', prompt: 'p' }];
    sanitizeGeneratedSamples(samples);
    assert.equal(samples[0].sample_id, 's001');
  });
});

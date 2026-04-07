/**
 * Agent evaluation feature tests:
 * - extractAgentTrace: message stream → turns + toolCalls
 * - Agent assertions: tools_called, tools_not_called, tools_count_max/min, tool_output_contains, turns_min
 * - buildTraceSummary: turns/toolCalls → judge context string
 * - schema: buildVariantResult/buildVariantSummary with agent metrics
 * - analyzer: detectToolPatterns
 * - renderer: renderAgentOverview
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { extractAgentTrace } from '../src/executors/index.js';
import { runAssertions, buildTraceSummary } from '../src/grading/index.js';
import { renderAgentOverview } from '../src/renderer/summary.js';
import { buildVariantResult, buildVariantSummary } from '../src/eval-core/schema.js';
import { analyzeResults } from '../src/analysis/report-diagnostics.js';
import type { ExecResult, Report, ToolCallInfo, TurnInfo } from '../src/types.js';

// ---------------------------------------------------------------------------
// extractAgentTrace
// ---------------------------------------------------------------------------

describe('extractAgentTrace', () => {
  it('extracts tool_use from assistant message and tool_result from user message', () => {
    const messages = [
      { type: 'system' },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu-1', name: 'Read', input: { file: 'package.json' } },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu-1', content: '{"name": "omk"}' },
          ],
        },
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'The project name is omk.' },
          ],
        },
      },
      { type: 'result', result: 'The project name is omk.' },
    ];

    const { turns, toolCalls } = extractAgentTrace(messages as never[]);

    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].tool, 'Read');
    assert.equal(toolCalls[0].success, true);
    assert.ok(String(toolCalls[0].output).includes('omk'));

    // turns: assistant(tool_use) → tool(result) → assistant(text)
    assert.equal(turns.length, 3);
    assert.equal(turns[0].role, 'assistant');
    assert.equal(turns[0].toolCalls?.length, 1);
    assert.equal(turns[1].role, 'tool');
    assert.equal(turns[2].role, 'assistant');
    assert.ok(turns[2].content.includes('omk'));
  });

  it('handles multiple tool calls in sequence', () => {
    const messages = [
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: { cmd: 'ls' } }] },
      },
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'file1.ts\nfile2.ts' }] },
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-2', name: 'Read', input: { file: 'file1.ts' } }] },
      },
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-2', content: 'export const x = 1;' }] },
      },
      { type: 'result', result: 'done' },
    ];

    const { toolCalls } = extractAgentTrace(messages as never[]);
    assert.equal(toolCalls.length, 2);
    assert.equal(toolCalls[0].tool, 'Bash');
    assert.equal(toolCalls[1].tool, 'Read');
  });

  it('marks failed tool calls with is_error', () => {
    const messages = [
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: { cmd: 'fail' } }] },
      },
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'command not found', is_error: true }] },
      },
      { type: 'result', result: '' },
    ];

    const { toolCalls } = extractAgentTrace(messages as never[]);
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].success, false);
  });

  it('returns empty for messages without tool usage', () => {
    const messages = [
      { type: 'system' },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] } },
      { type: 'result', result: 'Hello' },
    ];

    const { turns, toolCalls } = extractAgentTrace(messages as never[]);
    assert.equal(toolCalls.length, 0);
    assert.equal(turns.length, 1); // one text turn
  });

  it('skips thinking blocks', () => {
    const messages = [
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'thinking' }, { type: 'tool_use', id: 'tu-1', name: 'Read', input: {} }] },
      },
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'data' }] },
      },
      { type: 'result', result: '' },
    ];

    const { toolCalls } = extractAgentTrace(messages as never[]);
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].tool, 'Read');
  });
});

// ---------------------------------------------------------------------------
// Agent assertions
// ---------------------------------------------------------------------------

describe('agent assertions', () => {
  const toolCalls: ToolCallInfo[] = [
    { tool: 'Read', input: { file: 'a.ts' }, output: 'content of a', success: true },
    { tool: 'Bash', input: { cmd: 'ls' }, output: 'file list', success: true },
    { tool: 'Read', input: { file: 'b.ts' }, output: 'error', success: false },
  ];

  it('tools_called: passes when all specified tools were called', () => {
    const result = runAssertions('output', [
      { type: 'tools_called', values: ['Read', 'Bash'] },
    ], { toolCalls });
    assert.equal(result.passed, 1);
  });

  it('tools_called: fails when a specified tool was not called', () => {
    const result = runAssertions('output', [
      { type: 'tools_called', values: ['Read', 'Glob'] },
    ], { toolCalls });
    assert.equal(result.passed, 0);
  });

  it('tools_called: case insensitive', () => {
    const result = runAssertions('output', [
      { type: 'tools_called', values: ['read', 'bash'] },
    ], { toolCalls });
    assert.equal(result.passed, 1);
  });

  it('tools_not_called: passes when tools were not called', () => {
    const result = runAssertions('output', [
      { type: 'tools_not_called', values: ['Glob', 'Write'] },
    ], { toolCalls });
    assert.equal(result.passed, 1);
  });

  it('tools_not_called: fails when a forbidden tool was called', () => {
    const result = runAssertions('output', [
      { type: 'tools_not_called', values: ['Bash'] },
    ], { toolCalls });
    assert.equal(result.passed, 0);
  });

  it('tools_count_min: passes when enough tools called', () => {
    const result = runAssertions('output', [
      { type: 'tools_count_min', value: 2 },
    ], { toolCalls });
    assert.equal(result.passed, 1);
  });

  it('tools_count_min: fails when too few tools called', () => {
    const result = runAssertions('output', [
      { type: 'tools_count_min', value: 5 },
    ], { toolCalls });
    assert.equal(result.passed, 0);
  });

  it('tools_count_max: passes when within limit', () => {
    const result = runAssertions('output', [
      { type: 'tools_count_max', value: 5 },
    ], { toolCalls });
    assert.equal(result.passed, 1);
  });

  it('tools_count_max: fails when too many tools called', () => {
    const result = runAssertions('output', [
      { type: 'tools_count_max', value: 2 },
    ], { toolCalls });
    assert.equal(result.passed, 0);
  });

  it('tool_output_contains: passes when tool output matches', () => {
    const result = runAssertions('output', [
      { type: 'tool_output_contains', value: 'Read:content of a' },
    ], { toolCalls });
    assert.equal(result.passed, 1);
  });

  it('tool_output_contains: fails when tool output does not match', () => {
    const result = runAssertions('output', [
      { type: 'tool_output_contains', value: 'Read:something else' },
    ], { toolCalls });
    assert.equal(result.passed, 0);
  });

  it('tool_output_contains: fails for unknown tool', () => {
    const result = runAssertions('output', [
      { type: 'tool_output_contains', value: 'Glob:anything' },
    ], { toolCalls });
    assert.equal(result.passed, 0);
  });

  it('tool_input_contains: passes when tool input matches', () => {
    const result = runAssertions('output', [
      { type: 'tool_input_contains', value: 'Read:a.ts' },
    ], { toolCalls });
    assert.equal(result.passed, 1);
  });

  it('tool_input_contains: fails when tool input does not match', () => {
    const result = runAssertions('output', [
      { type: 'tool_input_contains', value: 'Read:nonexistent.ts' },
    ], { toolCalls });
    assert.equal(result.passed, 0);
  });

  it('tool_input_contains: case insensitive', () => {
    const result = runAssertions('output', [
      { type: 'tool_input_contains', value: 'read:A.TS' },
    ], { toolCalls });
    assert.equal(result.passed, 1);
  });

  it('turns_min: passes when enough turns', () => {
    const result = runAssertions('output', [
      { type: 'turns_min', value: 2 },
    ], { numTurns: 5 });
    assert.equal(result.passed, 1);
  });

  it('turns_min: fails when too few turns', () => {
    const result = runAssertions('output', [
      { type: 'turns_min', value: 10 },
    ], { numTurns: 3 });
    assert.equal(result.passed, 0);
  });

  it('agent assertions work without toolCalls context (empty array)', () => {
    const result = runAssertions('output', [
      { type: 'tools_count_min', value: 1 },
      { type: 'tools_called', values: ['Read'] },
    ]);
    assert.equal(result.passed, 0);
    assert.equal(result.total, 2);
  });
});

// ---------------------------------------------------------------------------
// buildTraceSummary
// ---------------------------------------------------------------------------

describe('buildTraceSummary', () => {
  it('returns null when no turns or toolCalls', () => {
    assert.equal(buildTraceSummary(undefined, undefined), null);
    assert.equal(buildTraceSummary([], []), null);
  });

  it('includes tool count and distribution', () => {
    const toolCalls: ToolCallInfo[] = [
      { tool: 'Read', input: {}, output: 'data', success: true },
      { tool: 'Read', input: {}, output: 'more', success: true },
      { tool: 'Bash', input: {}, output: 'list', success: false },
    ];
    const result = buildTraceSummary([], toolCalls)!;
    assert.ok(result.includes('3 个工具'));
    assert.ok(result.includes('2/3'));
    assert.ok(result.includes('失败 1/3'));
    assert.ok(result.includes('Read(2)'));
    assert.ok(result.includes('Bash(1)'));
  });

  it('includes turn summary', () => {
    const turns: TurnInfo[] = [
      { role: 'assistant', content: 'Let me read the file', toolCalls: [{ tool: 'Read', input: {}, output: 'data', success: true }] },
      { role: 'tool', content: 'file content here' },
      { role: 'assistant', content: 'The answer is 42' },
    ];
    const result = buildTraceSummary(turns, [])!;
    assert.ok(result.includes('执行轨迹摘要'));
    assert.ok(result.includes('共 3 步'));
    assert.ok(result.includes('Read'));
    assert.ok(result.includes('tool:'));
  });
});

// ---------------------------------------------------------------------------
// schema: buildVariantResult/buildVariantSummary with agent metrics
// ---------------------------------------------------------------------------

describe('schema agent metrics', () => {
  const baseExecResult: ExecResult = {
    ok: true, output: 'result', durationMs: 5000, durationApiMs: 4000,
    inputTokens: 100, outputTokens: 200, cacheReadTokens: 0, cacheCreationTokens: 0,
    costUSD: 0.05, stopReason: 'end', numTurns: 3,
    toolCalls: [
      { tool: 'Read', input: {}, output: 'data', success: true },
      { tool: 'Bash', input: {}, output: 'ok', success: true },
      { tool: 'Read', input: {}, output: 'error', success: false },
    ],
  };

  it('buildVariantResult includes agent metrics', () => {
    const vr = buildVariantResult(baseExecResult, null);
    assert.equal(vr.numToolCalls, 3);
    assert.equal(vr.numToolFailures, 1);
    assert.equal(vr.toolSuccessRate, 0.67);
    assert.equal(vr.traceCoverage, 0.75);
    assert.deepEqual(vr.toolNames, ['Read', 'Bash']);
  });

  it('buildVariantResult omits agent metrics when no toolCalls', () => {
    const noTools: ExecResult = { ...baseExecResult, toolCalls: undefined };
    const vr = buildVariantResult(noTools, null);
    assert.equal(vr.numToolCalls, undefined);
    assert.equal(vr.toolSuccessRate, undefined);
  });

  it('buildVariantSummary aggregates agent metrics', () => {
    const entries = [
      buildVariantResult({
        ...baseExecResult, turns: [
          { role: 'assistant', content: 'read', toolCalls: [{ tool: 'Read', input: {}, output: 'data', success: true }] },
          { role: 'tool', content: 'data' },
          { role: 'assistant', content: 'answer' },
        ]
      }, null),
      buildVariantResult({
        ...baseExecResult, toolCalls: [
          { tool: 'Glob', input: {}, output: 'files', success: true },
        ], turns: [
          { role: 'assistant', content: 'glob', toolCalls: [{ tool: 'Glob', input: {}, output: 'files', success: true }] },
          { role: 'tool', content: 'files' },
        ]
      }, null),
    ];
    const summary = buildVariantSummary(entries);
    assert.equal(summary.avgToolCalls, 2); // (3+1)/2
    assert.equal(summary.avgToolFailures, 0.5);
    assert.ok(summary.toolSuccessRate! > 0);
    assert.ok(summary.traceCoverageRate! > 0);
    assert.ok(summary.toolDistribution!['Read'] > 0);
    assert.ok(summary.toolDistribution!['Glob'] > 0);
  });

  it('buildVariantSummary omits agent metrics when no tool data', () => {
    const entries = [
      buildVariantResult({ ...baseExecResult, toolCalls: undefined }, null),
    ];
    const summary = buildVariantSummary(entries);
    assert.equal(summary.avgToolCalls, undefined);
  });
});

// ---------------------------------------------------------------------------
// analyzer: detectToolPatterns
// ---------------------------------------------------------------------------

describe('analyzer agent insights', () => {
  function toReport(value: unknown): Report {
    return value as Report;
  }

  it('detects low tool success rate', () => {
    const report = toReport({
      meta: { variants: ['v1', 'v2'] },
      summary: {
        v1: { avgToolCalls: 5, toolSuccessRate: 0.5, totalSamples: 3, successCount: 3 },
        v2: { avgToolCalls: 3, toolSuccessRate: 0.95, totalSamples: 3, successCount: 3 },
      },
      results: [{ sample_id: 's1', variants: { v1: { compositeScore: 3 }, v2: { compositeScore: 4 } } }],
    });
    const analysis = analyzeResults(report);
    const lowSR = analysis.insights.find((i) => i.type === 'low_tool_success_rate');
    assert.ok(lowSR, 'should detect low tool success rate');
    assert.equal(lowSR!.severity, 'warning');
  });

  it('detects tool count gap between variants', () => {
    const report = toReport({
      meta: { variants: ['v1', 'v2'] },
      summary: {
        v1: { avgToolCalls: 2, toolSuccessRate: 1, totalSamples: 3, successCount: 3 },
        v2: { avgToolCalls: 8, toolSuccessRate: 1, totalSamples: 3, successCount: 3 },
      },
      results: [{ sample_id: 's1', variants: { v1: { compositeScore: 3 }, v2: { compositeScore: 4 } } }],
    });
    const analysis = analyzeResults(report);
    const gap = analysis.insights.find((i) => i.type === 'tool_count_gap');
    assert.ok(gap, 'should detect tool count gap');
  });

  it('detects trace integrity gap', () => {
    const report = toReport({
      meta: { variants: ['baseline', 'project-env'] },
      summary: {
        baseline: { avgNumTurns: 1, totalSamples: 2, successCount: 2 },
        'project-env': { avgNumTurns: 3, avgToolCalls: 2, traceCoverageRate: 0.5, totalSamples: 2, successCount: 2 },
      },
      results: [{
        sample_id: 's1',
        variants: {
          baseline: { compositeScore: 3, assertions: { passed: 0, total: 1, score: 1, details: [{ type: 'tools_called', value: 'Read', weight: 1, passed: false }] } },
          'project-env': { compositeScore: 4, assertions: { passed: 1, total: 1, score: 5, details: [{ type: 'tools_called', value: 'Read', weight: 1, passed: true }] } },
        },
      }],
    });
    const analysis = analyzeResults(report);
    const integrityGap = analysis.insights.find((i) => i.type === 'trace_integrity_gap');
    assert.ok(integrityGap, 'should detect trace integrity gap');
  });

  it('detects tool permission errors separately from generic tool failures', () => {
    const report = toReport({
      meta: { variants: ['baseline', 'project-env'] },
      summary: {
        baseline: { avgToolCalls: 2, toolSuccessRate: 0.5, totalSamples: 1, successCount: 1 },
        'project-env': { avgToolCalls: 2, toolSuccessRate: 1, totalSamples: 1, successCount: 1 },
      },
      results: [{
        sample_id: 's1',
        variants: {
          baseline: {
            compositeScore: 2,
            toolCalls: [
              { tool: 'Glob', input: { pattern: '**/*' }, output: 'spawn rg EACCES', success: false },
            ],
          },
          'project-env': { compositeScore: 4 },
        },
      }],
    });
    const analysis = analyzeResults(report);
    const permissionIssue = analysis.insights.find((i) => i.type === 'tool_permission_error');
    assert.ok(permissionIssue, 'should detect tool permission error');
  });

  it('detects low agent assertion discrimination', () => {
    const report = toReport({
      meta: { variants: ['baseline', 'project-env', 'skill'] },
      summary: {
        baseline: { totalSamples: 2, successCount: 2 },
        'project-env': { totalSamples: 2, successCount: 2 },
        skill: { totalSamples: 2, successCount: 2 },
      },
      results: [
        {
          sample_id: 's1',
          variants: {
            baseline: {
              assertions: {
                passed: 1, total: 2, score: 3, details: [
                  { type: 'tools_called', value: 'Read', weight: 1, passed: true },
                  { type: 'turns_max', value: 3, weight: 1, passed: false },
                ]
              }
            },
            'project-env': {
              assertions: {
                passed: 1, total: 2, score: 3, details: [
                  { type: 'tools_called', value: 'Read', weight: 1, passed: true },
                  { type: 'turns_max', value: 3, weight: 1, passed: false },
                ]
              }
            },
            skill: {
              assertions: {
                passed: 1, total: 2, score: 3, details: [
                  { type: 'tools_called', value: 'Read', weight: 1, passed: true },
                  { type: 'turns_max', value: 3, weight: 1, passed: false },
                ]
              }
            },
          },
        },
        {
          sample_id: 's2',
          variants: {
            baseline: {
              assertions: {
                passed: 1, total: 2, score: 3, details: [
                  { type: 'tools_called', value: 'Read', weight: 1, passed: true },
                  { type: 'turns_max', value: 3, weight: 1, passed: false },
                ]
              }
            },
            'project-env': {
              assertions: {
                passed: 1, total: 2, score: 3, details: [
                  { type: 'tools_called', value: 'Read', weight: 1, passed: true },
                  { type: 'turns_max', value: 3, weight: 1, passed: false },
                ]
              }
            },
            skill: {
              assertions: {
                passed: 1, total: 2, score: 3, details: [
                  { type: 'tools_called', value: 'Read', weight: 1, passed: true },
                  { type: 'turns_max', value: 3, weight: 1, passed: false },
                ]
              }
            },
          },
        },
      ],
    });
    const analysis = analyzeResults(report);
    const lowDiscrimination = analysis.insights.find((i) => i.type === 'agent_assertion_discrimination_low');
    assert.ok(lowDiscrimination, 'should detect low agent assertion discrimination');
  });

  it('detects when agent assertion discrimination is healthy', () => {
    const report = toReport({
      meta: { variants: ['baseline', 'project-env', 'skill'] },
      summary: {
        baseline: { totalSamples: 2, successCount: 2 },
        'project-env': { totalSamples: 2, successCount: 2 },
        skill: { totalSamples: 2, successCount: 2 },
      },
      results: [
        {
          sample_id: 's1',
          variants: {
            baseline: {
              assertions: {
                passed: 0, total: 2, score: 1, details: [
                  { type: 'tools_called', value: 'Read', weight: 1, passed: false },
                  { type: 'turns_max', value: 3, weight: 1, passed: false },
                ]
              }
            },
            'project-env': {
              assertions: {
                passed: 1, total: 2, score: 3, details: [
                  { type: 'tools_called', value: 'Read', weight: 1, passed: true },
                  { type: 'turns_max', value: 3, weight: 1, passed: false },
                ]
              }
            },
            skill: {
              assertions: {
                passed: 2, total: 2, score: 5, details: [
                  { type: 'tools_called', value: 'Read', weight: 1, passed: true },
                  { type: 'turns_max', value: 3, weight: 1, passed: true },
                ]
              }
            },
          },
        },
        {
          sample_id: 's2',
          variants: {
            baseline: {
              assertions: {
                passed: 0, total: 2, score: 1, details: [
                  { type: 'tools_called', value: 'Read', weight: 1, passed: false },
                  { type: 'turns_max', value: 3, weight: 1, passed: false },
                ]
              }
            },
            'project-env': {
              assertions: {
                passed: 1, total: 2, score: 3, details: [
                  { type: 'tools_called', value: 'Read', weight: 1, passed: true },
                  { type: 'turns_max', value: 3, weight: 1, passed: false },
                ]
              }
            },
            skill: {
              assertions: {
                passed: 2, total: 2, score: 5, details: [
                  { type: 'tools_called', value: 'Read', weight: 1, passed: true },
                  { type: 'turns_max', value: 3, weight: 1, passed: true },
                ]
              }
            },
          },
        },
      ],
    });
    const analysis = analyzeResults(report);
    const healthyDiscrimination = analysis.insights.find((i) => i.type === 'agent_assertion_discrimination_ok');
    assert.ok(healthyDiscrimination, 'should detect healthy agent assertion discrimination');
  });

  it('skips agent assertion discrimination for lightweight runtime-marker checks', () => {
    const report = toReport({
      meta: { variants: ['baseline', 'project-env'] },
      summary: {
        baseline: { totalSamples: 2, successCount: 2 },
        'project-env': { totalSamples: 2, successCount: 2 },
      },
      results: [{
        sample_id: 's1',
        variants: {
          baseline: {
            assertions: {
              passed: 1, total: 2, score: 3, details: [
                { type: 'contains', value: 'OMK_RUNTIME', weight: 1, passed: false },
                { type: 'turns_max', value: 4, weight: 1, passed: true },
              ]
            }
          },
          'project-env': {
            assertions: {
              passed: 2, total: 2, score: 5, details: [
                { type: 'contains', value: 'OMK_RUNTIME', weight: 1, passed: true },
                { type: 'turns_max', value: 4, weight: 1, passed: true },
              ]
            }
          },
        },
      }],
    });
    const analysis = analyzeResults(report);
    assert.equal(analysis.insights.some((i) => i.type === 'agent_assertion_discrimination_low'), false);
    assert.equal(analysis.insights.some((i) => i.type === 'trace_integrity_gap'), false);
  });

  it('no agent insights when no tool data', () => {
    const report = toReport({
      meta: { variants: ['v1', 'v2'] },
      summary: {
        v1: { totalSamples: 3, successCount: 3 },
        v2: { totalSamples: 3, successCount: 3 },
      },
      results: [{ sample_id: 's1', variants: { v1: { compositeScore: 3 }, v2: { compositeScore: 4 } } }],
    });
    const analysis = analyzeResults(report);
    const agentInsights = analysis.insights.filter((i) => i.type === 'low_tool_success_rate' || i.type === 'tool_count_gap');
    assert.equal(agentInsights.length, 0);
  });
});

// ---------------------------------------------------------------------------
// renderer: renderAgentOverview
// ---------------------------------------------------------------------------

describe('renderAgentOverview', () => {
  it('returns empty string when no agent data', () => {
    const html = renderAgentOverview(['v1', 'v2'], {
      v1: { totalSamples: 2, successCount: 2, errorCount: 0, errorRate: 0, avgDurationMs: 1000, avgInputTokens: 100, avgOutputTokens: 200, avgTotalTokens: 300, totalCostUSD: 0.01, totalExecCostUSD: 0.008, totalJudgeCostUSD: 0.002, avgCostPerSample: 0.005, avgNumTurns: 1 },
      v2: { totalSamples: 2, successCount: 2, errorCount: 0, errorRate: 0, avgDurationMs: 1000, avgInputTokens: 100, avgOutputTokens: 200, avgTotalTokens: 300, totalCostUSD: 0.01, totalExecCostUSD: 0.008, totalJudgeCostUSD: 0.002, avgCostPerSample: 0.005, avgNumTurns: 1 },
    }, 'zh');
    assert.equal(html, '');
  });

  it('renders agent overview when tool data present', () => {
    const html = renderAgentOverview(['v1'], {
      v1: {
        totalSamples: 2, successCount: 2, errorCount: 0, errorRate: 0,
        avgDurationMs: 5000, avgInputTokens: 100, avgOutputTokens: 200, avgTotalTokens: 300,
        totalCostUSD: 0.05, totalExecCostUSD: 0.04, totalJudgeCostUSD: 0.01,
        avgCostPerSample: 0.025, avgNumTurns: 3,
        avgToolCalls: 2.5, toolSuccessRate: 0.9,
        toolDistribution: { Read: 3, Bash: 2 },
      },
    }, 'zh');
    assert.ok(html.includes('Agent 执行概览'));
    assert.ok(html.includes('2.5'));
    assert.ok(html.includes('90%'));
    assert.ok(html.includes('Read'));
    assert.ok(html.includes('Bash'));
  });
});

/**
 * 体检详情在 React 知识页的呈现，补齐被退役的 `/knowledge/doctors/:id` 独立页的差集：
 * 逐条 finding 与修复建议、多采样 k/n 支持度、采样降级告警、跨轮次体检历史与 `?doctorRun=` 下钻。
 *
 * 排序、剔除 `:_summary`、n>1 门槛等口径在 application/doctor-format 侧测（见
 * ../application/doctor-format.test.ts）；这里只锁用户实际读到的文字与链接。
 * Tabs 的 SSR 只输出激活面板，而体检是首个面板，所以逐条规则可直接断言。
 */
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, it } from 'vitest';
import type { DoctorRuleResult, DoctorRuleStatus } from '../../../src/knowledge-artifacts/doctor/contracts.js';
import { loadKnowledgePage } from '../../../src/studio/http/knowledge-page.js';
import type { KnowledgeQuery } from '../../../src/studio/application/knowledge-query.js';
import type {
  SkillDoctorSnapshot,
  SkillGraphSnapshot,
  SkillIndex,
  SkillIndexEntry,
} from '../../../src/studio/view-models/skill-index.js';
import { KnowledgeView } from '../../../src/studio/web/components/knowledge/knowledge.js';

type Lang = 'zh' | 'en';

function rule(ruleId: string, status: DoctorRuleStatus, detail: Record<string, unknown>): DoctorRuleResult {
  return {
    ruleId,
    groupId: ruleId.split(':')[0],
    severity: status === 'fail' ? 'fatal' : 'info',
    labelKey: `cli.doctor.${ruleId}`,
    status,
    message: `${ruleId} message`,
    detail,
    durationMs: 10,
  };
}

/** 一条维度规则：displayName 是人话标题，findings 是逐条结论。 */
function dimensionRule(
  ruleId: string,
  status: DoctorRuleStatus,
  findings: unknown[],
  hint?: string,
): DoctorRuleResult {
  return { ...rule(ruleId, status, { displayName: `维度 ${ruleId}`, findings }), ...(hint ? { hint } : {}) };
}

/** 引擎把采样元数据挂在 `:_summary` 的 detail.samples 上，它不是一条体检规则。 */
function summaryRule(samples: Record<string, unknown> | undefined): DoctorRuleResult {
  return rule('skill_health:_summary', samples ? 'warn' : 'pass', samples === undefined ? {} : { samples });
}

function snapshot(reportId: string, timestamp: string, results: DoctorRuleResult[]): SkillDoctorSnapshot {
  const failCount = results.filter((item) => item.status === 'fail').length;
  const warnCount = results.filter((item) => item.status === 'warn').length;
  return {
    reportId,
    timestamp,
    status: failCount ? 'fail' : warnCount ? 'warn' : 'pass',
    passCount: results.length - failCount - warnCount,
    warnCount,
    failCount,
    results,
  };
}

const CURRENT = snapshot('doctor-current', '2026-07-02T00:00:00.000Z', [
  dimensionRule('skill_health:a', 'fail', [
    { level: '错误', description: '引用了不存在的文件', suggestion: '补上引用或删除失效引用', support: { k: 3, n: 3 } },
    { level: '警告', description: '缺少回滚说明', support: { k: 1, n: 2 } },
  ], '先看第一条错误'),
  dimensionRule('skill_health:b', 'pass', []),
  summaryRule({ requested: 2, succeeded: 1, concurrency: 2, degraded: true }),
]);

const OLDER = snapshot('doctor-older', '2026-07-01T00:00:00.000Z', [
  dimensionRule('skill_health:a', 'warn', [{ level: '警告', description: '彼时只有一条弱信号' }]),
]);

function detailPage(
  runs: SkillDoctorSnapshot[],
  lang: Lang,
  doctorRunId?: string,
  graph?: SkillGraphSnapshot,
) {
  // doctorHistory 升序（最早 → 最近），当前 snapshot 等于最后一项 —— 与 buildSkillIndex 同形状。
  const entry: SkillIndexEntry = {
    skillName: 'demo',
    doctor: runs.at(-1) ?? null,
    observe: null,
    doctorHistory: runs,
    band: 'yellow',
    ...(graph ? { graph } : {}),
  };
  const index = {
    entries: [entry],
    summary: { totalSkills: 1, withObserve: 0, withDoctor: 1, red: 0, yellow: 1, green: 0, gray: 0 },
    insightsBySkill: new Map(),
    diagnosticsBySkill: new Map(),
    diagnosisSummary: {},
  } as unknown as SkillIndex;
  const query = { read: () => index } as unknown as KnowledgeQuery;
  const page = loadKnowledgePage(query, '/knowledge/skills/demo', lang, doctorRunId);
  assert.ok(page && page.pageKind === 'detail', 'detail page');
  return renderToString(createElement(KnowledgeView, { page, lang })).replaceAll('<!-- -->', '');
}

/** doctor graph sidecar 的投影：默认绑到当前轮次 `doctor-current` 的内容哈希上。 */
function graphSidecar(overrides: Partial<SkillGraphSnapshot> = {}): SkillGraphSnapshot {
  return {
    bindingStrength: 'content-hash',
    artifactHash: 'sha256:0f3a',
    doctor: {
      sourceKind: 'doctor',
      sourceId: 'doctor-current',
      graphId: 'doctor:doctor-current:demo',
      generatedAt: '2026-07-02T00:00:00.000Z',
      nodeCount: 12,
      edgeCount: 18,
      references: 3,
      scripts: 1,
      workflows: 2,
      workflowNodes: 5,
      hardRules: 4,
      definitionNodes: [
        { nodeKind: 'reference', label: 'a.md' },
        { nodeKind: 'reference', label: 'b.md' },
        { nodeKind: 'hard_rule', label: '不许直接推送 main' },
      ],
    },
    ...overrides,
  };
}

describe('体检详情的逐条规则', () => {
  it('问题项给出说明、修复建议与多采样支持度，单次采样不冒充共识', () => {
    const zh = detailPage([OLDER, CURRENT], 'zh');
    assert.match(zh, /引用了不存在的文件/);
    assert.match(zh, /补上引用或删除失效引用/);
    assert.match(zh, /缺少回滚说明/);
    // 规则级 message 与 hint 是引擎给的一句话结论和总建议；没有 finding 的规则只剩它们可读。
    assert.match(zh, /skill_health:a message/);
    assert.match(zh, /先看第一条错误/);
    assert.match(zh, /2 次采样里有 1 次报了这条/);
    assert.match(zh, /3 次采样里有 3 次报了这条/);
    assert.match(zh, />1\/2</);
    // displayName 是规则标题，ruleId 只留在数据里。
    assert.match(zh, /维度 skill_health:a/);
    // 摘要计数沿用报告自带的 pass/warn/fail —— 与列表「健康体检」列同一份数，含信息性 `:_summary`；
    // 逐条规则列表不含该行，所以「1 警告」可以只来自采样汇总，由上方的降级告警解释。
    assert.match(zh, />1 通过</);
    assert.match(zh, />1 警告</);
    assert.match(zh, />1 失败</);
  });

  it('信息性的 `:_summary` 不作为一条规则出现', () => {
    const zh = detailPage([OLDER, CURRENT], 'zh');
    assert.doesNotMatch(zh, /_summary/);
    assert.doesNotMatch(zh, /维度 skill_health:_summary/);
    // 通过项不丢弃，折到显式展开入口里。
    assert.match(zh, /展开 1 条通过的规则/);
  });

  it('全部采样失败时，唯一的失败记录仍可读，页面不宣称「所有规则通过」', () => {
    // composer 在解析不出任何维度时只回 errorSummaryOutcome（subId `_summary`、status fail）。
    const broken = snapshot('doctor-broken', '2026-07-05T00:00:00.000Z', [{
      ...rule('skill_health:_summary', 'fail', {
        displayName: '汇总',
        findings: [],
        samples: { requested: 2, succeeded: 0, concurrency: 2, degraded: true },
      }),
      message: '执行器不可用',
      hint: '检查 executor 配置后重跑 omk doctor',
    }]);
    const zh = detailPage([broken], 'zh');
    assert.match(zh, /执行器不可用/);
    assert.match(zh, /检查 executor 配置后重跑 omk doctor/);
    assert.doesNotMatch(zh, /所有规则通过/);
  });

  it('采样降级告警双语各自完整，英文页不残留中文口径', () => {
    const zh = detailPage([OLDER, CURRENT], 'zh');
    assert.match(zh, /共识置信降级/);
    assert.match(zh, /本次只成功解析 1\/2 次采样/);

    const en = detailPage([OLDER, CURRENT], 'en');
    assert.match(en, /Consensus confidence degraded/);
    assert.match(en, /Only 1\/2 samples parsed successfully/);
    assert.match(en, /title="Reported by 1 of 2 samples"/);
    assert.doesNotMatch(en, /次采样里有|共识置信降级/);
  });

  it('采样全部解析成功时不给降级告警', () => {
    const clean = snapshot('doctor-clean', '2026-07-03T00:00:00.000Z', [
      dimensionRule('skill_health:a', 'fail', [{ level: '错误', description: '仍然有失败项', support: { k: 2, n: 2 } }]),
      summaryRule({ requested: 2, succeeded: 2, concurrency: 2, degraded: false }),
    ]);
    const html = detailPage([clean], 'zh');
    assert.doesNotMatch(html, /共识置信降级/);
    assert.match(html, /仍然有失败项/);
  });

  it('存储里的文本按 React 口径转义，不作为标记注入', () => {
    const payload = '<img src=x onerror=alert(1)>';
    const dirty = snapshot('doctor-dirty', '2026-07-04T00:00:00.000Z', [
      dimensionRule('skill_health:a', 'fail', [{ level: '错误', description: payload, suggestion: payload }]),
    ]);
    const html = detailPage([dirty], 'zh');
    assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/);
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), '转义后仍需可见');
  });
});

describe('体检历史与下钻', () => {
  it('当前一次留作文本，其余给 `?doctorRun=` 链接并保留 lang', () => {
    const zh = detailPage([OLDER, CURRENT], 'zh');
    assert.match(zh, /体检历史/);
    assert.equal((zh.match(/doctorRun=doctor-older/g) ?? []).length, 1);
    assert.doesNotMatch(zh, /doctorRun=doctor-current/);
    assert.match(zh, /2026-07-01 00:00:00 UTC/);

    const en = detailPage([OLDER, CURRENT], 'en');
    assert.match(en, /Doctor history/);
    assert.match(en, /\?lang=en&amp;doctorRun=doctor-older/);
  });

  it('只有一轮体检时不给出历史区', () => {
    assert.doesNotMatch(detailPage([CURRENT], 'zh'), /体检历史/);
  });

  it('下钻到历史轮次时呈现那一次的规则，并给返回当前体检的入口', () => {
    const zh = detailPage([OLDER, CURRENT], 'zh', 'doctor-older');
    assert.match(zh, /彼时只有一条弱信号/);
    assert.doesNotMatch(zh, /引用了不存在的文件/, '历史轮次不得混入当前轮次的 finding');
    assert.match(zh, /← 返回当前体检/);
    assert.doesNotMatch(zh, /class="ant-tag ant-tag-processing[^"]*"[^>]*>当前</);
    // 历史行里被选中的那次不再自我链接。
    assert.doesNotMatch(zh, /doctorRun=doctor-older/);
    assert.match(detailPage([OLDER, CURRENT], 'en', 'doctor-older'), /← back to current run/);
  });

  it('未运行体检时给出空态而不是报错', () => {
    const html = detailPage([], 'zh');
    assert.match(html, /尚未运行体检/);
  });
});

describe('知识对象结构', () => {
  /** 每档一个名字与配色；弱绑定的否定口径写在正文里，不藏进 tooltip。 */
  const TIERS: [SkillGraphSnapshot['bindingStrength'], string, string, string][] = [
    ['content-hash', 'ant-tag-success', '内容哈希绑定', '可以跨机器核对到被体检的那份内容'],
    ['source-locator', 'ant-tag-warning', '仅来源路径一致', '内容有没有变动未被证明'],
    ['name-only', 'ant-tag-error', '仅名称一致', '这不是内容证明'],
    ['mixed', 'ant-tag-warning', '绑定强度不一', '按最弱的一档呈现'],
  ];
  const tierPage = (bindingStrength: SkillGraphSnapshot['bindingStrength']): string => detailPage(
    [CURRENT], 'zh', undefined, graphSidecar({ bindingStrength, artifactHash: undefined }),
  );

  it('四档绑定强度各自可读，只有内容哈希那一档能被读成内容证明', () => {
    for (const [bindingStrength, color, label, note] of TIERS) {
      const zh = tierPage(bindingStrength);
      assert.match(zh, new RegExp(`<span class="ant-tag[^"]*${color}[^"]*"[^>]*>${label}<`), bindingStrength);
      assert.match(zh, new RegExp(note), bindingStrength);
    }
    for (const [bindingStrength] of TIERS.filter(([strength]) => strength !== 'content-hash')) {
      assert.doesNotMatch(tierPage(bindingStrength), /可以跨机器核对/, `${bindingStrength} 不该被读成内容证明`);
    }
  });

  it('哈希与计数默认可读，来源定位符是本机绝对路径所以不进页面', () => {
    const zh = detailPage([CURRENT], 'zh', undefined, graphSidecar({
      bindingStrength: 'name-only',
      artifactHash: undefined,
      sourceLocator: '/Users/me/.claude/skills/demo/SKILL.md',
    }));
    assert.match(zh, /引用<\/span> <span[^>]*><strong>3<\/strong>/, '计数不需要展开就能读');
    assert.doesNotMatch(zh, /\/Users\/me\/\.claude/);
    assert.match(detailPage([CURRENT], 'zh', undefined, graphSidecar()), /sha256:0f3a/);

    const en = detailPage([CURRENT], 'en', undefined, graphSidecar());
    assert.match(en, />content-hash binding</);
    assert.match(en, /describes the exact content that was checked/);
    assert.doesNotMatch(en, /内容哈希绑定|跨机器核对/);
  });

  it('结构证据来自别的轮次时说明它不属于本轮计数', () => {
    const zh = detailPage([OLDER, CURRENT], 'zh', 'doctor-older', graphSidecar());
    assert.match(zh, /上面这份结构证据来自体检 doctor-current，当前查看的是 doctor-older/);
    assert.match(zh, /计数不属于本轮/);
    assert.match(detailPage([OLDER, CURRENT], 'en', 'doctor-older', graphSidecar()),
      /captured in run doctor-current while you are viewing doctor-older/);
  });

  it('定义节点折叠，只给「展开 N 个定义节点」入口；没有 sidecar 时整块不出现', () => {
    const zh = detailPage([CURRENT], 'zh', undefined, graphSidecar());
    assert.match(zh, /展开 3 个定义节点（2 类）/);
    assert.doesNotMatch(zh, /不许直接推送 main/, '定义节点默认折叠');
    assert.doesNotMatch(detailPage([CURRENT], 'zh'), /知识对象结构/);
  });

  it('sidecar 里的文本按 React 口径转义，不作为标记注入', () => {
    const payload = '<img src=x onerror=alert(1)>';
    const zh = detailPage([CURRENT], 'zh', undefined, graphSidecar({
      artifactHash: payload,
    }));
    assert.doesNotMatch(zh, /<img src=x onerror=alert\(1\)>/);
    assert.ok(zh.includes('&lt;img src=x onerror=alert(1)&gt;'), '转义后仍需可见');
  });
});

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadTraceCorpus, type CcRecord } from '../../../src/observability/trace/index.js';
import { claudeMetadataEvidence, claudeTranscriptEvidence, detectJsonlFormats, detectJsonlTraceSource, openClawMessageEvidence, openClawSessionEvidence, type JsonlTraceAdapter } from '../../../src/observability/trace/source.js';
import { openStreamedJsonlRecords } from '../../../src/observability/trace/streamed-records.js';
import { codexFormatEvidence, codexGuardianEvidence } from '../../../src/observability/trace/adapters/codex/trace.js';
import { qoderFormatEvidence } from '../../../src/observability/trace/adapters/qoder/trace.js';
import { traceFixture } from '../../helpers/trace-fixtures.js';

const fixture = traceFixture();

type DetectedFormat = JsonlTraceAdapter['sourceKind'];

function naiveMatchingKinds(records: Array<CcRecord | undefined>): DetectedFormat[] {
  const has = (evidence: (value: unknown) => boolean) => records.some((record) => evidence(record));
  const kinds: DetectedFormat[] = [];
  if (has(codexFormatEvidence)) kinds.push('codex');
  if (has(openClawSessionEvidence) && has(openClawMessageEvidence)) kinds.push('openclaw');
  if (has(qoderFormatEvidence)) kinds.push('qoder');
  if (!has(qoderFormatEvidence)
    && (has(claudeTranscriptEvidence) || has(claudeMetadataEvidence))) kinds.push('claude');
  return kinds;
}

function detectionFixture(dir: string, name: string, entries: unknown[]): {
  path: string;
  records: Array<CcRecord | undefined>;
} {
  const lines: string[] = [];
  const records: Array<CcRecord | undefined> = [];
  for (const entry of entries) {
    if (typeof entry === 'string') {
      lines.push(entry);
      records.push(undefined);
      continue;
    }
    const line = JSON.stringify(entry);
    lines.push(line);
    // 与读文件一样重新解一份，用例之间不共享同一个记录对象。
    records.push(JSON.parse(line) as CcRecord);
  }
  const path = join(dir, `${name}.jsonl`);
  writeFileSync(path, `${lines.join('\n')}\n`);
  return { path, records };
}

const codexSessionMeta = {
  timestamp: '2026-07-25T00:00:00.000Z',
  type: 'session_meta',
  payload: { id: 'merged-codex', session_id: 'merged-codex', cwd: '/repo', model_provider: 'openai' },
};

const codexGuardianMeta = {
  timestamp: '2026-07-25T00:00:00.000Z',
  type: 'session_meta',
  payload: {
    id: 'merged-guardian',
    cwd: '/repo',
    model_provider: 'openai',
    source: { subagent: 'guardian' },
  },
};

const claudeTranscript = {
  type: 'assistant',
  uuid: 'merged-claude-a1',
  parentUuid: null,
  sessionId: 'merged-claude',
  timestamp: '2026-04-19T10:00:00.000Z',
  message: { role: 'assistant', content: [{ type: 'text', text: '好' }] },
};

const qoderTranscript = {
  type: 'user',
  uuid: 'merged-qoder-u1',
  parentUuid: null,
  sessionId: 'merged-qoder',
  timestamp: '2026-04-19T10:00:00.000Z',
  requestSetId: 'req-1',
  message: { role: 'user', content: '继续' },
};

describe('JSONL 格式判定的单遍合并', () => {
  it('合并扫描与逐格式 some 组合对同一份记录给出同一份判定', () => {
    const cases: Array<{ name: string; entries: unknown[]; kinds: DetectedFormat[]; filtered?: boolean }> = [
      { name: 'codex-only', entries: [codexSessionMeta], kinds: ['codex'] },
      { name: 'codex-guardian', entries: [codexGuardianMeta], kinds: ['codex'], filtered: true },
      { name: 'claude-only', entries: [claudeTranscript], kinds: ['claude'] },
      { name: 'qoder-only', entries: [qoderTranscript], kinds: ['qoder'] },
      {
        name: 'openclaw-only',
        entries: [
          { type: 'session', id: 'merged-openclaw', timestamp: '2026-05-12T00:00:00.000Z' },
          { type: 'message', id: 'm1', timestamp: '2026-05-12T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: '检查配置' }] } },
        ],
        kinds: ['openclaw'],
      },
      {
        // 存在性 AND：合并扫描把「每条子句是否出现过」分开存再合成，所以只满足 openclaw 第一条
        // 子句的文件不得判成 openclaw——这一条也是「判定单位是子句集合而非单个谓词」的直接反证。
        name: 'openclaw-partial',
        entries: [
          { type: 'session', id: 'merged-partial', timestamp: '2026-05-12T00:00:00.000Z' },
        ],
        kinds: [],
      },
      {
        // 空洞：畸形行、非对象值、纯空白行都不构成任何格式的证据。
        name: 'codex-with-holes',
        entries: ['{broken', codexSessionMeta, '[1,2,3]', 'null', '   '],
        kinds: ['codex'],
      },
      {
        name: 'claude-with-holes',
        entries: ['not json', claudeTranscript, '42', '[]'],
        kinds: ['claude'],
      },
      {
        // 歧义：同一份文件既像 Codex 又像 Claude，判定不得静默归给其中一家。
        name: 'ambiguous-codex-claude',
        entries: [codexSessionMeta, claudeTranscript],
        kinds: ['codex', 'claude'],
      },
      {
        name: 'ambiguous-codex-qoder',
        entries: [qoderTranscript, codexSessionMeta],
        kinds: ['codex', 'qoder'],
      },
      {
        // 否定项要的是「整档都没有」：qoder 证据出现在最后一条时，claude 也不能因为提前停止
        // 就认定自己命中。
        name: 'claude-then-qoder-tail',
        entries: [
          claudeTranscript,
          { type: 'mode', sessionId: 'merged-claude', mode: 'normal' },
          qoderTranscript,
        ],
        kinds: ['qoder'],
      },
    ];

    for (const testCase of cases) {
      const { path, records } = detectionFixture(fixture.directory, testCase.name, testCase.entries);
      const kindsOf = (list: Iterable<CcRecord | undefined>) =>
        detectJsonlFormats(list).matching.map((adapter) => adapter.sourceKind);
      const detection = detectJsonlFormats(records);
      const matched = detection.matching.map((adapter) => adapter.sourceKind);
      const holeless = records.filter((record): record is CcRecord => record !== undefined);
      const expected = testCase.kinds;

      assert.deepEqual(matched, expected, `${testCase.name}：单遍扫描的命中集合`);
      assert.deepEqual(
        matched,
        naiveMatchingKinds(records),
        `${testCase.name}：合并扫描必须与逐格式 some 组合同结果`,
      );
      assert.deepEqual(kindsOf(holeless), expected, `${testCase.name}：空洞不是证据，去掉后结论不变`);
      const view = openStreamedJsonlRecords<CcRecord>(path);
      try {
        assert.deepEqual(kindsOf(view.values), expected, `${testCase.name}：惰性视图必须同结果`);
      } finally {
        view.close();
      }

      // 丢弃证据只在「唯一命中 Codex」时才被查阅，因此它的布尔值要单独与整档 some 对齐。
      assert.equal(
        detection.satisfied(codexGuardianEvidence),
        records.some((record) => codexGuardianEvidence(record)),
        `${testCase.name}：guardian 证据`,
      );
      const detected = detectJsonlTraceSource(path, records);
      assert.equal(
        detected?.sourceKind,
        expected.length === 1 ? expected[0] : undefined,
        `${testCase.name}：只有唯一命中才归因`,
      );
      const corpus = loadTraceCorpus(path);
      if (testCase.filtered) {
        assert.deepEqual(corpus.sessions, [], `${testCase.name}：guardian 子代理日志整份丢弃`);
        assert.equal(corpus.ingestion.filteredSessionCount, 1, testCase.name);
      } else {
        assert.equal(
          corpus.sessions[0].sourceKind,
          expected.length === 1 ? expected[0] : 'unknown',
          `${testCase.name}：用户可见的宿主归因`,
        );
      }
    }
  });
});

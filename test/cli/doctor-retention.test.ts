import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneDoctorHistory } from '../../src/cli/commands/doctor.js';
import { writeMeasurementReportBundle } from '../../src/evidence/storage/report-bundle.js';

function doctorReport(skillName: string, id: string, timestamp: string) {
  return {
    kind: 'doctor',
    schemaVersion: '3.0.0',
    id,
    timestamp,
    cliVersion: 'test',
    cwd: '/workspace',
    executorName: 'codex',
    model: 'test-model',
    skills: [{ skillName, skillPath: `/workspace/${skillName}`, status: 'pass', results: [] }],
    totals: { pass: 1, warn: 0, fail: 0 },
    ruleStats: { pass: 0, warn: 0, fail: 0, skipped: 0, total: 0 },
    outcome: 'passed',
  };
}

// 制造 N 份 single-skill doctor report bundle，timestamp 严格递增，record id 按时间编号，
// 方便断言保留集合是否最近的 K 份。
function seedDoctorHistory(dir: string, skillName: string, count: number): string[] {
  const files: string[] = [];
  for (let i = 0; i < count; i++) {
    const timestamp = `2026-05-${String(10 + i).padStart(2, '0')}T00:00:00.000Z`;
    const id = `r${String(i).padStart(3, '0')}`;
    const recordId = `${skillName}-${id}`;
    writeMeasurementReportBundle({
      rootDir: dir,
      measurementDomain: 'doctor',
      recordId,
      reportId: id,
      createdAt: timestamp,
      report: doctorReport(skillName, id, timestamp),
    });
    files.push(recordId);
  }
  return files;
}

describe('pruneDoctorHistory', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omk-doctor-retention-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('保留 maxKeep 份最近的(按 timestamp 倒排),其余删除', () => {
    seedDoctorHistory(dir, 'code-review', 10);
    pruneDoctorHistory(dir, 'code-review', 3);
    const remaining = readdirSync(dir).sort();
    // r007 / r008 / r009 timestamp 最新,应保留
    expect(remaining).toEqual([
      'code-review-r007',
      'code-review-r008',
      'code-review-r009',
    ]);
  });

  it('总数不超 maxKeep 时不动任何文件', () => {
    seedDoctorHistory(dir, 'code-review', 3);
    pruneDoctorHistory(dir, 'code-review', 5);
    expect(readdirSync(dir)).toHaveLength(3);
  });

  it('不动其它 skill 的报告', () => {
    seedDoctorHistory(dir, 'code-review', 5);
    seedDoctorHistory(dir, 'doc-writer', 5);
    pruneDoctorHistory(dir, 'code-review', 2);
    const remaining = readdirSync(dir).sort();
    // doc-writer 5 份全留,code-review 只剩最新 2 份
    expect(remaining.filter((f) => f.startsWith('doc-writer-'))).toHaveLength(5);
    expect(remaining.filter((f) => f.startsWith('code-review-'))).toHaveLength(2);
  });

  it('忽略旧 `{name}.json` doctor 文件且不修改用户文件', () => {
    writeFileSync(
      join(dir, 'code-review.json'),
      JSON.stringify(doctorReport('code-review', 'bare-json', '2025-01-01T00:00:00.000Z')),
    );
    seedDoctorHistory(dir, 'code-review', 3);
    pruneDoctorHistory(dir, 'code-review', 2);
    const remaining = readdirSync(dir).sort();
    expect(remaining).toContain('code-review.json');
    expect(remaining).toEqual([
      'code-review-r001',
      'code-review-r002',
      'code-review.json',
    ]);
  });

  it('忽略 non-doctor / 多 skill / 损坏 JSON', () => {
    writeFileSync(join(dir, 'eval-report.json'), JSON.stringify({ kind: 'evaluation' }));
    writeFileSync(join(dir, 'multi-skill.json'), JSON.stringify({
      kind: 'doctor',
      skills: [{ skillName: 'a' }, { skillName: 'b' }],
    }));
    writeFileSync(join(dir, 'corrupt.json'), '{ not json');
    seedDoctorHistory(dir, 'code-review', 5);
    pruneDoctorHistory(dir, 'code-review', 2);
    const remaining = readdirSync(dir).sort();
    // 三个非候选文件全留,code-review 剩 2 份
    expect(remaining).toContain('eval-report.json');
    expect(remaining).toContain('multi-skill.json');
    expect(remaining).toContain('corrupt.json');
    expect(remaining.filter((f) => f.startsWith('code-review-'))).toHaveLength(2);
  });

  it('正文 id 与文件名不一致时不删除，避免误删被替换文件', () => {
    seedDoctorHistory(dir, 'code-review', 3);
    const forged = 'code-review-r999';
    mkdirSync(join(dir, forged));
    writeFileSync(
      join(dir, forged, 'report.json'),
      JSON.stringify(doctorReport('code-review', 'different-id', '2020-01-01T00:00:00.000Z')),
    );

    pruneDoctorHistory(dir, 'code-review', 1);

    expect(readdirSync(dir)).toContain(forged);
    expect(readdirSync(dir).filter((file) => /^code-review-r00[0-2]$/.test(file))).toHaveLength(1);
  });
});

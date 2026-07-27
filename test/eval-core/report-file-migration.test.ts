import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateLegacyReportFiles } from '../../src/eval-core/report-file-migration.js';
import {
  doctorReportFileStem,
  reportFileName,
} from '../../src/eval-core/artifact-file-names.js';

function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'omk-report-migration-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('migrateLegacyReportFiles', () => {
  it('doctor stem preserves ordinary names and separates lossy-safe collisions', () => {
    expect(doctorReportFileStem('code-review', 'doctor-r1')).toBe('code-review-r1');
    expect(doctorReportFileStem('a:b', 'doctor-r1')).not.toBe(
      doctorReportFileStem('a_b', 'doctor-r1'),
    );
    expect(doctorReportFileStem('skill', 'doctor-a:b')).not.toBe(
      doctorReportFileStem('skill', 'doctor-a_b'),
    );
  });

  it('迁移 eval report 裸 .json 到 .report.json', () => withDir((dir) => {
    writeFileSync(join(dir, 'r1.json'), JSON.stringify({
      kind: 'evaluation',
      id: 'r1',
      meta: {},
      summary: {},
      results: [],
    }));

    migrateLegacyReportFiles(dir, 'report');

    expect(existsSync(join(dir, 'r1.json'))).toBe(false);
    expect(existsSync(join(dir, reportFileName('r1')))).toBe(true);
  }));

  it('迁移 doctor report 时使用 canonical skill-run stem', () => withDir((dir) => {
    writeFileSync(join(dir, 'code-review-doctor-r1.json'), JSON.stringify({
      kind: 'doctor',
      id: 'doctor-r1',
      timestamp: '2026-06-20T00:00:00.000Z',
      skills: [{ skillName: 'code-review', status: 'pass', results: [] }],
      totals: { pass: 1, warn: 0, fail: 0 },
      outcome: 'passed',
    }));

    migrateLegacyReportFiles(dir, 'doctor');

    expect(existsSync(join(dir, 'code-review-doctor-r1.json'))).toBe(false);
    expect(existsSync(join(dir, reportFileName('code-review-r1')))).toBe(true);
  }));

  it('迁移 observe-health / observe-inbox 旧域后缀文件', () => withDir((dir) => {
    writeFileSync(join(dir, '2026-06-20T00-00-00-abcd-observe-health.json'), JSON.stringify({
      kind: 'observe-health',
      meta: {},
      bySkill: {},
      overall: {},
    }));
    migrateLegacyReportFiles(dir, 'observe-health');
    expect(existsSync(join(dir, reportFileName('2026-06-20T00-00-00-abcd')))).toBe(true);

    writeFileSync(join(dir, '2026-06-20T00-00-00-efgh-observe-inbox.json'), JSON.stringify({
      kind: 'observe-inbox',
      meta: {},
      items: [],
    }));
    migrateLegacyReportFiles(dir, 'observe-inbox');
    expect(existsSync(join(dir, reportFileName('2026-06-20T00-00-00-efgh')))).toBe(true);
  }));

  it('目标文件已存在且内容相同时删除 legacy duplicate', () => withDir((dir) => {
    const target = join(dir, reportFileName('r1'));
    const report = { kind: 'evaluation', id: 'r1', meta: {}, summary: {}, results: [] };
    writeFileSync(target, JSON.stringify(report));
    writeFileSync(join(dir, 'r1.json'), JSON.stringify(report, null, 2));

    migrateLegacyReportFiles(dir, 'report');

    expect(existsSync(join(dir, 'r1.json'))).toBe(false);
    expect(JSON.parse(readFileSync(target, 'utf-8')).meta).toEqual({});
  }));

  it('目标文件与 legacy 内容冲突时两份都保留，迁移不得静默丢数据', () => withDir((dir) => {
    const target = join(dir, reportFileName('r1'));
    writeFileSync(target, JSON.stringify({ kind: 'evaluation', id: 'r1', meta: {}, summary: {}, results: [] }));
    writeFileSync(join(dir, 'r1.json'), JSON.stringify({
      kind: 'evaluation',
      id: 'r1',
      meta: { old: true },
      summary: {},
      results: [],
    }));

    migrateLegacyReportFiles(dir, 'report');

    expect(existsSync(join(dir, 'r1.json'))).toBe(true);
    expect(JSON.parse(readFileSync(target, 'utf-8')).meta).toEqual({});
  }));
});

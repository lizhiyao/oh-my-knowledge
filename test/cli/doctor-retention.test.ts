import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneDoctorHistory } from '../../src/cli/commands/doctor.js';

// 制造 N 份 single-skill doctor JSON 文件,timestamp 严格递增,文件名按时间编号
// 方便断言保留集合是否最近的 K 份。
function seedDoctorHistory(dir: string, skillName: string, count: number): string[] {
  const files: string[] = [];
  for (let i = 0; i < count; i++) {
    const timestamp = `2026-05-${String(10 + i).padStart(2, '0')}T00:00:00.000Z`;
    const file = `${skillName}-r${String(i).padStart(3, '0')}.json`;
    writeFileSync(join(dir, file), JSON.stringify({
      kind: 'doctor',
      id: `r${i}`,
      timestamp,
      skills: [{ skillName, status: 'pass', results: [] }],
      totals: { pass: 1, warn: 0, fail: 0 },
      outcome: 'passed',
    }));
    files.push(file);
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
      'code-review-r007.json',
      'code-review-r008.json',
      'code-review-r009.json',
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

  it('清理遗留 `{name}.json` 命名:同 skill 旧文件也参与轮换', () => {
    // 旧 schema:文件名是 {skill}.json,timestamp 是早期
    writeFileSync(join(dir, 'code-review.json'), JSON.stringify({
      kind: 'doctor',
      id: 'legacy',
      timestamp: '2025-01-01T00:00:00.000Z',
      skills: [{ skillName: 'code-review', status: 'pass', results: [] }],
      totals: { pass: 1, warn: 0, fail: 0 },
      outcome: 'passed',
    }));
    // 加 3 份新 schema(timestamp 更新)
    seedDoctorHistory(dir, 'code-review', 3);
    pruneDoctorHistory(dir, 'code-review', 2);
    const remaining = readdirSync(dir).sort();
    // 总 4 份,留 2 份最新,旧 schema 的 `code-review.json` (2025-01) timestamp 最老应被删
    expect(remaining).not.toContain('code-review.json');
    expect(remaining).toHaveLength(2);
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
});

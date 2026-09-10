import { readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { indexDoctorWrite, removeDoctorCard } from '../../evidence/storage/discovery-index.js';
import { doctorReportFileStem } from '../../evidence/storage/file-names.js';
import { listMeasurementReportPaths, measurementRecordIdFromReportPath, writeMeasurementReportBundle } from '../../evidence/storage/report-bundle.js';
import { persistDoctorGraphSidecars, removeDoctorGraphSidecars } from '../../evidence/graph/doctor.js';
import type { DoctorOutcome, DoctorReport } from './contracts.js';
import { parseDoctorReport } from './report-parser.js';

// 每个 skill 最多保留多少份历史 doctor 报告(避免无界增长拖慢 studio 启动 +
// scanDoctorReports 扫盘成本)。50 = ~每天 1 跑撑 1.5 个月 sparkline,够用。
const DOCTOR_HISTORY_MAX_PER_SKILL = 50;

export function persistDoctorReport(report: DoctorReport, dir: string, lang: 'zh' | 'en'): string[] {
  const warnings: string[] = [];
  for (const skill of report.skills) {
    const counts: Pick<DoctorReport['ruleStats'], 'pass' | 'warn' | 'fail' | 'skipped'> = {
      pass: 0,
      warn: 0,
      fail: 0,
      skipped: 0,
    };
    for (const r of skill.results) {
      const s = r.status;
      if (s in counts) counts[s]++;
    }
    const outcome: DoctorOutcome = skill.status === 'fail' ? 'failed' : skill.status === 'warn' ? 'warnings_only' : 'passed';
    const perSkill: DoctorReport = {
      ...report,
      skills: [skill],
      ruleStats: {
        pass: counts.pass,
        warn: counts.warn,
        fail: counts.fail,
        skipped: counts.skipped,
        total: skill.results.length,
      },
      totals: {
        pass: skill.status === 'pass' ? 1 : 0,
        warn: skill.status === 'warn' ? 1 : 0,
        fail: skill.status === 'fail' ? 1 : 0,
      },
      outcome,
    };
    const cardId = doctorReportFileStem(skill.skillName, report.id);
    const parsed = parseDoctorReport(perSkill);
    if (!parsed) throw new Error('invalid doctor report');
    const { reportPath: filePath } = writeMeasurementReportBundle({
      rootDir: dir,
      measurementDomain: 'doctor',
      recordId: cardId,
      reportId: report.id,
      createdAt: report.timestamp,
      report: parsed,
    });
    // 产物发现索引:per-skill 报告落项目本地后,best-effort 追加全局轻卡片,让 studio 跨项目聚合。
    indexDoctorWrite({
      id: cardId, path: filePath, skillName: skill.skillName, reportId: report.id, timestamp: report.timestamp,
      status: skill.status, passCount: counts.pass, warnCount: counts.warn, failCount: counts.fail,
    }, dir);
    try {
      persistDoctorGraphSidecars({
        report: perSkill,
        skill,
        sourcePath: filePath,
        outputDir: dir,
        fileStem: cardId,
        lang,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(message);
    }
  }
  warnings.push(...pruneDoctorHistory(dir, report.skills.map((skill) => skill.skillName), DOCTOR_HISTORY_MAX_PER_SKILL));
  return warnings;
}

// 写入新报告后调用:扫 dir 里属于该 skill 的所有 single-skill doctor report,
// 按 timestamp 倒排,保留 maxKeep 份最近的,其余删。按 content 匹配 skillName 不
// 看文件名,所以清理逻辑不依赖 readdir 顺序或 stem 推断 skill 名。
export function pruneDoctorHistory(dir: string, skillNames: readonly string[], maxKeep: number): string[] {
  if (!Number.isSafeInteger(maxKeep) || maxKeep < 0) {
    throw new TypeError('maxKeep must be a non-negative safe integer');
  }
  const selected = new Set(skillNames);
  const groups = new Map<string, { path: string; graphStem: string; timestamp: string }[]>();
  const warnings: string[] = [];
  for (const path of listMeasurementReportPaths(dir, 'doctor')) {
    try {
      const data = parseDoctorReport(JSON.parse(readFileSync(path, 'utf-8')));
      if (!data || data.skills.length !== 1) continue;
      const skillName = data.skills[0].skillName;
      if (!selected.has(skillName)) continue;
      const expectedStem = doctorReportFileStem(skillName, data.id);
      if (measurementRecordIdFromReportPath(path) !== expectedStem) continue;
      const candidates = groups.get(skillName) ?? [];
      groups.set(skillName, candidates);
      candidates.push({
        path,
        graphStem: expectedStem,
        timestamp: data.timestamp,
      });
    } catch { /* skip corrupt / unrelated json */ }
  }
  for (const candidates of groups.values()) {
    candidates.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    for (const { path, graphStem } of candidates.slice(maxKeep)) {
      try {
        rmSync(dirname(path), { recursive: true, force: true });
      } catch (error) {
        warnings.push(String(error));
        continue;
      }
      // 连带删卡片:否则被 prune 掉的报告会经 listDoctorCards 合并在本项目 studio「复活」(正文已删、卡片还在)。
      // 卡片 id = 文件 stem(`{name}-{id}`),与 indexDoctorWrite 写入口径一致。
      removeDoctorCard(graphStem);
      removeDoctorGraphSidecars(dir, graphStem);
    }
  }
  return warnings;
}

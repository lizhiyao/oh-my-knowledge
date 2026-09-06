import { tCli, type CliLang } from './i18n.js';
import type { DoctorProgressInfo } from '../../knowledge-artifacts/doctor/contracts.js';

// 图标 + 状态枚举(pass/warn/fail 是技术枚举,与图标一样语言无关,不进 i18n 模板)。
const DOCTOR_STATUS_LABEL: Record<string, string> = {
  pass: '✓ pass',
  warn: '⚠ warn',
  fail: '✗ fail',
};

/** doctor 批量体检进度打印（逐 skill，写入 stderr）。 */
export function makeDoctorProgress(lang: CliLang): (info: DoctorProgressInfo) => void {
  return (info: DoctorProgressInfo): void => {
    // 单 skill 时省略 [i/n] 前缀(冗余);批量才显示计数。
    const prefix = info.total > 1 ? `[${info.index}/${info.total}] ` : '';
    if (info.phase === 'skill_start') {
      process.stderr.write(tCli('cli.doctor.progress_skill_start', lang, { prefix, skill: info.skillName }));
    } else {
      const result = DOCTOR_STATUS_LABEL[info.status ?? 'pass'] ?? DOCTOR_STATUS_LABEL.pass;
      process.stderr.write(tCli('cli.doctor.progress_skill_done', lang, {
        prefix, skill: info.skillName, result, ms: info.durationMs ?? 0,
      }));
    }
  };
}

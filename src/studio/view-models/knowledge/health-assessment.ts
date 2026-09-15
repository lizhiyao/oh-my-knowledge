import type { StudioTone } from '../display/tone.js';
import type { SkillHealthBand } from './skill-index.js';

/**
 * 知识列表／详情的综合健康判定。
 *
 * - `band` 是测量档位口径（与 `/api/skills` 的 `entry.band`、观测报告的 `healthBand` 同一套名字），
 *   机读面上保持稳定。
 * - `tone` 是它的呈现投影，取全站唯一词表 `StudioTone`；页面只按 `tone` 着色，不再自己翻译颜色名。
 * - `label` 按请求语言给出，green 档下「健康」与「良好」同色，只有 label 分得开。
 */
export interface HealthAssessment {
  score: number | null;
  band: SkillHealthBand;
  tone: StudioTone;
  label: string;
}

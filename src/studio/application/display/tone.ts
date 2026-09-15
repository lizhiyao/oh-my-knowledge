import type { SkillHealthBand } from '../../view-models/knowledge/skill-index.js';
import type { StudioTone } from '../../view-models/display/tone.js';

/**
 * 综合健康档位 → 呈现色调的唯一映射。
 *
 * `band` 是测量口径（`/api/skills` 原样交出，机读面稳定），`tone` 是它在页面上的着色投影，
 * 两者因此分开建模：改档位规则要动测量口径，改配色只动这一处。`gray` 表示「没有可信证据」，
 * 与 underpowered 一样落到不给硬色的 neutral。
 */
export function healthBandTone(band: SkillHealthBand): StudioTone {
  return band === 'green' ? 'success' : band === 'yellow' ? 'warning' : band === 'red' ? 'error' : 'neutral';
}

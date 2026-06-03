import { readFileSync, existsSync } from 'node:fs';
import yaml from 'js-yaml';
import { registerHealthDimension } from './dimension-registry.js';
import type { HealthDimensionSpec } from './dimension-spec.js';
import type { DoctorSeverity } from '../../types/doctor.js';

interface RawDimension {
  id: string;
  displayName: string;
  severity?: string;
  promptSection: string;
}

const VALID_SEVERITIES = new Set(['fatal', 'warn', 'info']);

export function loadAndRegisterCustomDimensions(filePath: string): number {
  if (!existsSync(filePath)) {
    throw new Error(`自定义维度配置文件不存在: ${filePath}`);
  }
  const raw = readFileSync(filePath, 'utf-8');
  const doc = yaml.load(raw) as { dimensions?: RawDimension[] } | null;
  if (!doc?.dimensions || !Array.isArray(doc.dimensions)) return 0;

  let count = 0;
  for (const dim of doc.dimensions) {
    if (!dim.id || !dim.displayName || !dim.promptSection) {
      throw new Error(`自定义维度缺少必填字段（id/displayName/promptSection）: ${JSON.stringify(dim).slice(0, 100)}`);
    }
    const severity: DoctorSeverity = VALID_SEVERITIES.has(dim.severity ?? '') ? dim.severity as DoctorSeverity : 'warn';
    const spec: HealthDimensionSpec = {
      id: dim.id,
      displayName: dim.displayName,
      labelKey: `cli.doctor.health.dim.${dim.id}`,
      severity,
      promptSection: dim.promptSection,
    };
    registerHealthDimension(spec);
    count++;
  }
  return count;
}

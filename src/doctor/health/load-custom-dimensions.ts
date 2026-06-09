import { readFileSync, existsSync } from 'node:fs';
import yaml from 'js-yaml';
import { registerHealthDimension } from './dimension-registry.js';
import { registerRule } from '../rules.js';
import { makeEndpointRule } from '../endpoint-rule.js';
import type { HealthDimensionSpec } from './dimension-spec.js';
import type { DoctorSeverity } from '../../types/doctor.js';

interface RawDimension {
  id: string;
  displayName: string;
  severity?: string;
  /** LLM 维度:喂给健康度 prompt 的检查内容。与 endpoint 二选一。 */
  promptSection?: string;
  /** 接口维度:doctor 把 skill 快照 POST 到此地址,按协议返回判定。与 promptSection 二选一。 */
  endpoint?: string;
  /** 接口维度:透传给 endpoint 的自定义参数。 */
  params?: Record<string, unknown>;
  /** 接口维度:是否把子文件内容一起传(默认 true)。 */
  includeFiles?: boolean;
  /** 接口维度:附加请求头(eg. 鉴权 token)。 */
  headers?: Record<string, string>;
}

const VALID_SEVERITIES = new Set(['fatal', 'warn', 'info']);

function resolveSeverity(raw?: string): DoctorSeverity {
  return VALID_SEVERITIES.has(raw ?? '') ? (raw as DoctorSeverity) : 'warn';
}

/**
 * 加载自定义维度 YAML 并注册。两类维度按字段自动分流:
 *   - 带 `endpoint` → 接口维度,注册成独立 DoctorRule(运行时 POST skill 快照)。
 *   - 带 `promptSection` → LLM 维度,注册进 health composer(原逻辑)。
 * 返回成功注册的维度数量。
 */
export function loadAndRegisterCustomDimensions(filePath: string): number {
  if (!existsSync(filePath)) {
    throw new Error(`自定义维度配置文件不存在: ${filePath}`);
  }
  const raw = readFileSync(filePath, 'utf-8');
  const doc = yaml.load(raw) as { dimensions?: RawDimension[] } | null;
  if (!doc?.dimensions || !Array.isArray(doc.dimensions)) return 0;

  let count = 0;
  for (const dim of doc.dimensions) {
    if (!dim.id || !dim.displayName) {
      throw new Error(`自定义维度缺少必填字段（id/displayName）: ${JSON.stringify(dim).slice(0, 100)}`);
    }
    if (dim.endpoint && dim.promptSection) {
      throw new Error(`自定义维度 ${dim.id} 不能同时配置 endpoint 与 promptSection（二选一）`);
    }
    const severity = resolveSeverity(dim.severity);

    if (dim.endpoint) {
      registerRule(makeEndpointRule({
        id: dim.id,
        displayName: dim.displayName,
        severity,
        endpoint: dim.endpoint,
        params: dim.params,
        includeFiles: dim.includeFiles,
        headers: dim.headers,
      }));
      count++;
      continue;
    }

    if (!dim.promptSection) {
      throw new Error(`自定义维度 ${dim.id} 必须配置 endpoint 或 promptSection 之一`);
    }
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

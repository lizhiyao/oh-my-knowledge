import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  WIRE_SCHEMA_CATALOG,
  wireSchemaCatalogVersion,
} from '../../src/eval-core/contracts/index.js';
import {
  CURRENT_RELEASE_DECISION_POLICY_IMPLEMENTATION_ID,
} from '../../src/eval-workflows/runtime-adapter/analysis/release-decision.js';

const RELEASE_DECISION_DOCS = [
  'docs/explanation/architecture.md',
  'docs/zh/explanation/architecture.md',
  'docs/explanation/statistical-rigor.md',
  'docs/zh/explanation/statistical-rigor.md',
] as const;

const SCHEMA_CATALOG_DOCS = [
  {
    path: 'docs/reference/embedded-api.md',
    counts: (total: number, v4: number, v3: number, v2: number, v1: number) =>
      `The catalog contains ${total} root contract names; ${v4} current roots use v4, ${v3} use v3, ${v2} use v2, and ${v1} use v1.`,
  },
  {
    path: 'docs/zh/reference/embedded-api.md',
    counts: (total: number, v4: number, v3: number, v2: number, v1: number) =>
      `Catalog 共包含 ${total} 个根契约名称；当前有 ${v4} 个根契约使用 v4，${v3} 个使用 v3，${v2} 个使用 v2，${v1} 个使用 v1。`,
  },
] as const;

describe('current evaluation contract documentation', () => {
  it('tracks the production Release Decision identity in both languages', () => {
    for (const path of RELEASE_DECISION_DOCS) {
      const source = readFileSync(resolve(path), 'utf8');
      expect(source).toContain(`\`${CURRENT_RELEASE_DECISION_POLICY_IMPLEMENTATION_ID}\``);
    }
  });

  it('tracks the generated wire-schema catalog counts in both languages', () => {
    const counts = new Map<string, number>();
    for (const entry of WIRE_SCHEMA_CATALOG) {
      const version = wireSchemaCatalogVersion(entry);
      counts.set(version, (counts.get(version) ?? 0) + 1);
    }
    const v1 = counts.get('v1') ?? 0;
    const v2 = counts.get('v2') ?? 0;
    const v3 = counts.get('v3') ?? 0;
    const v4 = counts.get('v4') ?? 0;

    for (const { path, counts: expectedCounts } of SCHEMA_CATALOG_DOCS) {
      const source = readFileSync(resolve(path), 'utf8');
      expect(source).toContain(expectedCounts(WIRE_SCHEMA_CATALOG.length, v4, v3, v2, v1));
      expect(source).toContain('resolveEvaluationCoreJsonSchema');
    }
  });
});

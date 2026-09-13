import { describe, expect, it } from 'vitest';
import { PUBLIC_API, sourceExportNames } from './public-api-contract.js';

/**
 * 公开 API 的源码层快速反馈：直接解析 src 的 .ts 入口，不依赖 build。
 *
 * 只校验导出名集合是否齐全；值/类型分类与发布产物一致性由
 * public-api.test.ts 在 dist 层锁定。改 src 不 build 时，本文件仍能
 * 立刻发现「源码导出与契约不符」，而不必等完整构建。
 */
describe('eval-runtime source export allowlist', () => {
  for (const [subpath, contract] of Object.entries(PUBLIC_API)) {
    it(`exposes every allowlisted export name from src ${subpath}`, () => {
      const expected = [...contract.values, ...contract.types].sort();
      expect(sourceExportNames(contract.entry)).toEqual(expected);
    });
  }
});

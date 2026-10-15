import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { isInstalledSkillAssetPath } from '../../../src/observability/trace/attribution.js';

describe('source-neutral skill asset paths', () => {
  it('recognizes supported installation roots without provider-specific inbox logic', () => {
    const paths = [
      '/home/me/.agents/skills/audit/examples/schema.md',
      '/home/me/.claude/skills/audit/examples/schema.md',
      '/home/me/.codex/skills/audit/examples/schema.md',
      '/home/me/.codex/skills/.system/audit/examples/schema.md',
      '/home/me/.codex/plugins/cache/vendor/plugin/skills/audit/examples/schema.md',
      '/home/me/.openclaw/workspace-main/skills/audit/examples/schema.md',
      'C:\\Users\\me\\.codex\\skills\\audit\\examples\\schema.md',
    ];
    for (const path of paths) {
      assert.equal(isInstalledSkillAssetPath(path, 'audit'), true, path);
    }
    assert.equal(isInstalledSkillAssetPath('/repo/examples/skills/audit/schema.md', 'audit'), false);
    assert.equal(isInstalledSkillAssetPath('/home/me/.codex/skills/other/schema.md', 'audit'), false);
  });
});

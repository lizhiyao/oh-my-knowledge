import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { renderEnvironmentSection } from '../../../src/eval-workflows/production-host/environment.js';

describe('renderEnvironmentSection', () => {
  it('returns null when no environment field', () => {
    assert.equal(renderEnvironmentSection(undefined), null);
    assert.equal(renderEnvironmentSection({}), null);
  });

  it('renders cli_available', () => {
    const out = renderEnvironmentSection({ cli_available: ['node', 'git'] });
    assert.ok(out!.includes('题设声明可用的 CLI'));
    assert.ok(out!.includes('`node`'));
    assert.ok(out!.includes('`git`'));
    assert.ok(out!.includes('不会自动创建文件或修改 runtime 环境'));
  });

  it('renders files_available + notes', () => {
    const out = renderEnvironmentSection({
      files_available: ['~/.req-tool-api.json', '$SKILL_DIR/scripts/x.js'],
      notes: 'DevAPI 凭证有效',
    });
    assert.ok(out!.includes('~/.req-tool-api.json'));
    assert.ok(out!.includes('$SKILL_DIR/scripts/x.js'));
    assert.ok(out!.includes('DevAPI 凭证有效'));
  });
});

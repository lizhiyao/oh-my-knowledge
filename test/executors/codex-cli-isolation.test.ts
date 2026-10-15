import { it } from 'vitest';
import assert from 'node:assert/strict';
import { codexCliExecutor } from '../../src/executors/openai/codex/cli.js';
import { codexSdkExecutor } from '../../src/executors/openai/codex/sdk.js';

it('refuses unprovable Codex skill isolation before opening either runtime, including an empty cwd', async () => {
  for (const execute of [codexCliExecutor, codexSdkExecutor]) {
    for (const allowedSkills of [[], ['one'], ['one', 'two']]) {
      for (const cwd of [undefined, '', '/tmp/isolated']) {
        await assert.rejects(() => execute({ model: 'fixture', prompt: '', cwd, allowedSkills }), /不支持显式 allowedSkills 隔离/);
      }
    }
  }
});

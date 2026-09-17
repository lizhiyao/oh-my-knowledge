/**
 * oclif 路径 studio 命令验收。
 * studio 是 server 长跑,不实际启 server,只测 --help 双语 + flag 校验。
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { renderCommandHelp } from '../helpers/run-command.js';
import { runCliFailing } from '../helpers/cli-process.js';

describe('oclif studio', () => {
  it('--help 默认 zh', async () => {
    const stdout = await renderCommandHelp('studio');
    assert.ok(stdout.includes('启动 omk Studio'), `stdout missing zh description:\n${stdout}`);
    assert.ok(stdout.includes('--port'), 'stdout missing --port flag');
    assert.ok(stdout.includes('--no-open'), 'stdout missing --no-open flag');
    assert.ok(stdout.includes('--dev'), 'stdout missing --dev flag');
  });

  it('--help --lang en', async () => {
    const stdout = await renderCommandHelp('studio', 'en');
    assert.ok(stdout.includes('Start omk Studio'), 'stdout should contain en description');
  });

  it('非法 --port → exit 2 + 中文 parser 错误', async () => {
    const { stderr } = await runCliFailing(['studio', '--port', '70000'], 2);
    assert.match(stderr, /--port(?=[\s\S]*整数)(?=[\s\S]*0)(?=[\s\S]*65535)/, `stderr missing zh parser error:\n${stderr}`);
  });
});

/**
 * 测试隔离守卫:vitest.config 用 OMK_HOME 把整棵默认产物树重定向到临时目录后,
 * 全局测量目录(reports / doctors / observe-health / state)必须都落在 temp,绝不指向真实 ~/.oh-my-knowledge。
 * 这道断言把「一处 OMK_HOME 隔离整棵树」的接线钉死:谁日后改回写死 home / 漏了 env 接线,这里立刻红。
 * 防的是「从注入不进的深层调用点写全局默认目录、静默污染开发者真实 home」那类回归。
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { OMK_HOME } from '../../src/measurement-artifacts/default-dirs.js';
import { globalReportsDir } from '../../src/measurement-artifacts/directories.js';
import { globalObserveHealthDir, globalDoctorsDir } from '../../src/measurement-artifacts/directories.js';

describe('OMK_HOME 测试隔离守卫', () => {
  const realHome = join(homedir(), '.oh-my-knowledge');

  it('OMK_HOME 被 vitest env 重定向,不等于真实 ~/.oh-my-knowledge', () => {
    assert.notEqual(OMK_HOME, realHome, 'OMK_HOME 应指向 temp,而非真实 home');
  });

  it('全局测量目录(reports / doctors / observe-health)都不落真实 home', () => {
    for (const d of [globalReportsDir(), globalDoctorsDir(), globalObserveHealthDir()]) {
      assert.ok(!d.startsWith(realHome), `${d} 不得指向真实 ~/.oh-my-knowledge`);
      assert.ok(d.startsWith(OMK_HOME), `${d} 应从重定向后的 OMK_HOME 派生`);
    }
  });
});

import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLI_DICT } from '../src/cli/lib/i18n-dict.js';
import { tCli, getCliLang, resolveCliLang } from '../src/cli/lib/i18n.js';

describe('CLI i18n dictionary parity (zh ↔ en)', () => {
  it('every key has both zh and en, neither empty', () => {
    for (const [key, entry] of Object.entries(CLI_DICT)) {
      assert.equal(typeof entry.zh, 'string', `${key}.zh must be string`);
      assert.equal(typeof entry.en, 'string', `${key}.en must be string`);
      assert.notEqual(entry.zh, '', `${key}.zh is empty`);
      assert.notEqual(entry.en, '', `${key}.en is empty`);
    }
  });
});

describe('tCli()', () => {
  it('returns zh value by default when lang omitted', () => {
    assert.equal(tCli('cli.common.unknown_domain'), CLI_DICT['cli.common.unknown_domain'].zh);
  });

  it('returns en value when lang=en', () => {
    assert.equal(tCli('cli.common.unknown_domain', 'en'), CLI_DICT['cli.common.unknown_domain'].en);
  });

  it('substitutes {param} placeholders', () => {
    const out = tCli('cli.common.unknown_domain', 'en', { domain: 'foo' });
    assert.match(out, /foo/);
    assert.doesNotMatch(out, /\{domain\}/);
  });

  it('replaces all occurrences of a placeholder', () => {
    const out = tCli('cli.run.batch_verdict_header', 'zh', { status: '未通过', passed: 1, total: 2 });
    assert.match(out, /1/);
    assert.doesNotMatch(out, /\{passed\}/);
  });
});

describe('getCliLang()', () => {
  let originalEnv: string | undefined;
  let originalHome: string | undefined;
  let machineRoot: string;
  const NO_SIGNAL: NodeJS.ProcessEnv = {};

  beforeEach(() => {
    originalEnv = process.env.OMK_LANG;
    originalHome = process.env.OMK_HOME;
    // 已保存设置是解析链的一档:不隔离到临时根,就会读到开发者真机的 settings.json。
    machineRoot = mkdtempSync(join(tmpdir(), 'omk-cli-lang-'));
    process.env.OMK_HOME = machineRoot;
    delete process.env.OMK_LANG;
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.OMK_LANG;
    else process.env.OMK_LANG = originalEnv;
    if (originalHome === undefined) delete process.env.OMK_HOME;
    else process.env.OMK_HOME = originalHome;
    rmSync(machineRoot, { recursive: true, force: true });
  });

  it('defaults to zh when no flag, no env and no locale signal', () => {
    assert.equal(getCliLang(undefined, NO_SIGNAL), 'zh');
  });

  it('reads OMK_LANG=en from env', () => {
    assert.equal(getCliLang(undefined, { OMK_LANG: 'en' }), 'en');
  });

  it('flag value beats env', () => {
    assert.equal(getCliLang('zh', { OMK_LANG: 'en' }), 'zh');
  });

  it('silently falls back on unknown value', () => {
    assert.equal(getCliLang('fr', NO_SIGNAL), 'zh');
    assert.equal(getCliLang(undefined, { OMK_LANG: 'jp' }), 'zh');
  });

  it('empty string flag is ignored (falls through to env / default)', () => {
    assert.equal(getCliLang('', { OMK_LANG: 'en' }), 'en');
  });

  it('系统 locale 只在没有显式信号时决定默认语言', () => {
    assert.equal(getCliLang(undefined, { LANG: 'en_US.UTF-8' }), 'en');
    assert.equal(getCliLang(undefined, { LANG: 'fr_FR.UTF-8' }), 'zh');
    assert.equal(getCliLang(undefined, { LANG: 'en_US.UTF-8', OMK_LANG: 'zh' }), 'zh');
    assert.equal(getCliLang('en', { LANG: 'zh_CN.UTF-8' }), 'en');
  });

  it('已保存设置优先于系统 locale', () => {
    writeFileSync(join(machineRoot, 'settings.json'), JSON.stringify({ schemaVersion: 1, language: 'zh' }));
    assert.equal(getCliLang(undefined, { LANG: 'en_US.UTF-8' }), 'zh');
  });

  it('settings 文件损坏时不抛错,退回 locale／兜底', () => {
    writeFileSync(join(machineRoot, 'settings.json'), '{ not json');
    assert.equal(getCliLang(undefined, { LANG: 'en_US.UTF-8' }), 'en');
    assert.equal(getCliLang(undefined, NO_SIGNAL), 'zh');
  });

  it('resolveCliLang 报告语言是否来自显式信号', () => {
    assert.deepEqual(resolveCliLang(undefined, { LANG: 'en_US.UTF-8' }), { lang: 'en', configured: false });
    assert.deepEqual(resolveCliLang(undefined, NO_SIGNAL), { lang: 'zh', configured: false });
    assert.deepEqual(resolveCliLang('en', NO_SIGNAL), { lang: 'en', configured: true });
    assert.deepEqual(resolveCliLang(undefined, { OMK_LANG: 'en' }), { lang: 'en', configured: true });
    writeFileSync(join(machineRoot, 'settings.json'), JSON.stringify({ schemaVersion: 1, language: 'en' }));
    assert.deepEqual(resolveCliLang(undefined, NO_SIGNAL), { lang: 'en', configured: true });
  });
});

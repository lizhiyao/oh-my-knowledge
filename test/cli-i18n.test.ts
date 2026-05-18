import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { CLI_DICT } from '../src/cli/lib/i18n-dict.js';
import { tCli, getCliLang } from '../src/cli/lib/i18n.js';

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
  beforeEach(() => {
    originalEnv = process.env.OMK_LANG;
    delete process.env.OMK_LANG;
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.OMK_LANG;
    else process.env.OMK_LANG = originalEnv;
  });

  it('defaults to zh when no flag and no env', () => {
    assert.equal(getCliLang(), 'zh');
  });

  it('reads OMK_LANG=en from env', () => {
    process.env.OMK_LANG = 'en';
    assert.equal(getCliLang(), 'en');
  });

  it('flag value beats env', () => {
    process.env.OMK_LANG = 'en';
    assert.equal(getCliLang('zh'), 'zh');
  });

  it('silently falls back to zh on unknown value', () => {
    assert.equal(getCliLang('fr'), 'zh');
    process.env.OMK_LANG = 'jp';
    assert.equal(getCliLang(), 'zh');
  });

  it('empty string flag is ignored (falls through to env / default)', () => {
    process.env.OMK_LANG = 'en';
    assert.equal(getCliLang(''), 'en');
  });
});

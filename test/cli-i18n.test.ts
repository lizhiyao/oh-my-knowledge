import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { CLI_DICT } from '../src/cli/i18n-dict.js';
import { tCli, getCliLang } from '../src/cli/i18n.js';

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
    assert.equal(tCli('cli.common.help_hint'), CLI_DICT['cli.common.help_hint'].zh);
  });

  it('returns en value when lang=en', () => {
    assert.equal(tCli('cli.common.help_hint', 'en'), CLI_DICT['cli.common.help_hint'].en);
  });

  it('substitutes {param} placeholders', () => {
    const out = tCli('cli.common.unknown_command', 'en', { command: 'foo' });
    assert.match(out, /foo/);
    assert.doesNotMatch(out, /\{command\}/);
  });

  it('replaces all occurrences of a placeholder', () => {
    const out = tCli('cli.common.lang_invalid_silent', 'zh', { value: 'fr' });
    assert.match(out, /fr/);
    assert.doesNotMatch(out, /\{value\}/);
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

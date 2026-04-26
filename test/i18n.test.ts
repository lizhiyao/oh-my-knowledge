import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { I18N, DEFAULT_LANG, t } from '../src/renderer/layout.js';

describe('i18n dictionary parity (zh ↔ en)', () => {
  it('zh and en have identical key sets', () => {
    const zhKeys = new Set(Object.keys(I18N.zh));
    const enKeys = new Set(Object.keys(I18N.en));
    const onlyInZh = [...zhKeys].filter((k) => !enKeys.has(k)).sort();
    const onlyInEn = [...enKeys].filter((k) => !zhKeys.has(k)).sort();
    assert.deepEqual(onlyInZh, [], `keys present in zh but missing in en: ${onlyInZh.join(', ')}`);
    assert.deepEqual(onlyInEn, [], `keys present in en but missing in zh: ${onlyInEn.join(', ')}`);
  });

  it('no value is empty in either language', () => {
    for (const lang of ['zh', 'en'] as const) {
      for (const [key, val] of Object.entries(I18N[lang])) {
        assert.notEqual(val, '', `I18N.${lang}.${key} is empty`);
        assert.equal(typeof val, 'string', `I18N.${lang}.${key} must be a string`);
      }
    }
  });
});

describe('t() helper', () => {
  it('returns zh value for known zh key', () => {
    assert.equal(t('title', 'zh'), I18N.zh.title);
  });

  it('returns en value for known en key', () => {
    assert.equal(t('title', 'en'), I18N.en.title);
  });

  it('defaults to zh when lang argument omitted', () => {
    assert.equal(t('title'), I18N.zh.title);
  });

  it('falls back to the key itself when both langs miss it', () => {
    const unknown = '__nonexistent_i18n_key_for_test__';
    assert.equal(t(unknown), unknown);
    assert.equal(t(unknown, 'en'), unknown);
  });

  it('DEFAULT_LANG is zh', () => {
    assert.equal(DEFAULT_LANG, 'zh');
  });
});

/**
 * 展示语言解析口径的唯一单测 —— 优先级与 locale 推断都在这里钉住，
 * CLI（getCliLang）与设置解析（UserSettingsStore.resolve）共用同一实现。
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  FALLBACK_LANG,
  inferLangFromLocale,
  isLang,
  localeLanguageTag,
  resolveLanguagePreference,
} from '../../src/shared/language-preference.js';

describe('isLang()', () => {
  it('只接受 zh / en,不接受 locale tag 形态', () => {
    assert.equal(isLang('zh'), true);
    assert.equal(isLang('en'), true);
    assert.equal(isLang('en_US'), false);
    assert.equal(isLang('fr'), false);
    assert.equal(isLang(undefined), false);
    assert.equal(isLang(null), false);
  });
});

describe('localeLanguageTag()', () => {
  it('POSIX 覆盖链:LC_ALL > LC_MESSAGES > LANG', () => {
    assert.equal(localeLanguageTag({ LC_ALL: 'en_US.UTF-8', LANG: 'zh_CN.UTF-8' }), 'en_US.UTF-8');
    assert.equal(localeLanguageTag({ LC_MESSAGES: 'en_US.UTF-8', LANG: 'zh_CN.UTF-8' }), 'en_US.UTF-8');
    assert.equal(localeLanguageTag({ LANG: 'zh_CN.UTF-8' }), 'zh_CN.UTF-8');
  });

  it('空值与 C / POSIX 视为没有信号', () => {
    assert.equal(localeLanguageTag({}), undefined);
    assert.equal(localeLanguageTag({ LANG: '' }), undefined);
    assert.equal(localeLanguageTag({ LANG: '  ' }), undefined);
    assert.equal(localeLanguageTag({ LC_ALL: 'C', LANG: 'en_US.UTF-8' }), 'en_US.UTF-8');
    assert.equal(localeLanguageTag({ LANG: 'POSIX' }), undefined);
  });
});

describe('inferLangFromLocale()', () => {
  it('识别 zh / en 两类前缀的常见形态', () => {
    assert.equal(inferLangFromLocale({ LANG: 'zh_CN.UTF-8' }), 'zh');
    assert.equal(inferLangFromLocale({ LANG: 'en_US.UTF-8' }), 'en');
    assert.equal(inferLangFromLocale({ LANG: 'en-US' }), 'en');
    assert.equal(inferLangFromLocale({ LANG: 'zh-Hans-CN' }), 'zh');
    assert.equal(inferLangFromLocale({ LANG: 'EN' }), 'en');
  });

  it('未支持的系统语言不推断为英文,交给兜底', () => {
    assert.equal(inferLangFromLocale({ LANG: 'fr_FR.UTF-8' }), undefined);
    assert.equal(inferLangFromLocale({ LANG: 'ja_JP.UTF-8' }), undefined);
    assert.equal(inferLangFromLocale({ LANG: 'C.UTF-8' }), undefined);
    assert.equal(inferLangFromLocale({}), undefined);
  });
});

describe('resolveLanguagePreference()', () => {
  it('优先级:显式覆盖 > OMK_LANG > 已保存设置 > 系统 locale > 兜底', () => {
    const env = { OMK_LANG: 'en', LANG: 'en_US.UTF-8' };
    assert.deepEqual(resolveLanguagePreference({ override: 'zh', env }), { lang: 'zh', configured: true });
    assert.deepEqual(resolveLanguagePreference({ override: 'fr', env }), { lang: 'en', configured: true });
    assert.deepEqual(
      resolveLanguagePreference({ override: 'fr', stored: 'en', env: { LANG: 'zh_CN.UTF-8' } }),
      { lang: 'en', configured: true },
    );
    assert.deepEqual(
      resolveLanguagePreference({ stored: 'en', env: { LANG: 'zh_CN.UTF-8' } }),
      { lang: 'en', configured: true },
    );
    assert.deepEqual(
      resolveLanguagePreference({ env: { LANG: 'en_US.UTF-8' } }),
      { lang: 'en', configured: false },
    );
    assert.deepEqual(resolveLanguagePreference({ env: {} }), { lang: FALLBACK_LANG, configured: false });
  });

  it('locale 推断与兜底都算「未固定」,显式三档才算已固定', () => {
    assert.equal(resolveLanguagePreference({ env: { LANG: 'en_US.UTF-8' } }).configured, false);
    assert.equal(resolveLanguagePreference({ env: {} }).configured, false);
    assert.equal(resolveLanguagePreference({ override: ' zh ', env: {} }).configured, true);
  });

  it('忽略空白差异,不把空串当显式信号', () => {
    assert.deepEqual(resolveLanguagePreference({ override: '', stored: 'en', env: {} }), { lang: 'en', configured: true });
    assert.deepEqual(resolveLanguagePreference({ override: '  ', env: { LC_ALL: 'en' } }), { lang: 'en', configured: false });
  });
});

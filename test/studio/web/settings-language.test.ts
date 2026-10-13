/**
 * 设置抽屉的语言取值形状：`auto` 是唯一能表达「不固定」的选项，保存时必须省略字段。
 * 写回当前生效语言会把系统 locale 的一次推断固化成显式设置，之后换系统语言也不再跟随。
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { languageField } from '../../../src/studio/web/components/layout/settings-language.js';
import { EffectiveSettings } from '../../../src/studio/web/components/layout/settings.js';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import type { StudioSettings } from '../../../src/studio/view-models/settings/settings.js';

describe('languageField()', () => {
  it('auto 省略 language 字段', () => {
    assert.deepEqual(languageField('auto'), {});
    assert.equal('language' in languageField('auto'), false);
  });

  it('显式 zh / en 原样写入', () => {
    assert.deepEqual(languageField('zh'), { language: 'zh' });
    assert.deepEqual(languageField('en'), { language: 'en' });
  });

  it('有效值与保存值分开呈现，缺席模型不冒充已配置且外部文本转义', () => {
    const data: StudioSettings = { path: '/local/settings.json', revision: 'missing', settings: { schemaVersion: 1, knowledge: { workspace: '/saved', executor: 'codex', model: 'saved-model' } },
      effective: { workspace: '/effective/<script>', executor: 'openai-api', model: '', language: 'en' }, defaults: { workspace: '/default', executor: 'codex', model: '' }, overrides: ['OMK_EXECUTOR'] };
    for (const lang of ['zh', 'en'] as const) {
      const html = renderToString(createElement(EffectiveSettings, { data, lang }));
      assert.ok(html.includes('/effective/&lt;script&gt;') && html.includes('openai-api') && html.includes('English'));
      assert.ok(html.includes(lang === 'zh' ? '每次选择模型' : 'Choose a model per extraction'));
      assert.ok(!html.includes('saved-model') && !html.includes('/saved') && !html.includes('<script>'));
    }
  });
});

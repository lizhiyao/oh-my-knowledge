/**
 * 设置抽屉的语言取值形状：`auto` 是唯一能表达「不固定」的选项，保存时必须省略字段。
 * 写回当前生效语言会把系统 locale 的一次推断固化成显式设置，之后换系统语言也不再跟随。
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { languageField } from '../../../src/studio/web/components/layout/settings-language.js';

describe('languageField()', () => {
  it('auto 省略 language 字段', () => {
    assert.deepEqual(languageField('auto'), {});
    assert.equal('language' in languageField('auto'), false);
  });

  it('显式 zh / en 原样写入', () => {
    assert.deepEqual(languageField('zh'), { language: 'zh' });
    assert.deepEqual(languageField('en'), { language: 'en' });
  });
});

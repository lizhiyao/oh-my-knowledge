/**
 * oclif 路径 i18n helper 单测 — bilingual() footgun assertion。
 *
 * bilingual({zh, en}) 拼成 `${zh}\n${en}` 串塞给 oclif Command 的 description / flag
 * description 字段。两类内容会破坏下游 pickLang 切分 + oclif Help ejs.render:
 *
 *   1. 真换行(\n) — pickLang 第一行当 zh 后续全归 en,codegen 跟 help 一起错位。
 *   2. ejs 模板标记(`<%` / `%>`)— oclif Help 用 ejs.render(body, context) 渲染所有
 *      section,description 拼了用户输入 + ejs 标记会被执行成任意代码。by-design
 *      的模板只在 example.command 字段(如 `<%= config.bin %>`),那里不走 bilingual()。
 *
 * 本测试锁这两类异常 input 必须在 bilingual() 入口抛错。
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { bilingual, LANG_FLAG } from '../../src/cli/oclif/i18n.js';

describe('oclif/i18n bilingual() footgun', () => {
  it('正常 single-line zh + en 返回 `${zh}\\n${en}`', () => {
    const out = bilingual({ zh: '初始化项目', en: 'Init project' });
    assert.equal(out, '初始化项目\nInit project');
  });

  it('zh 含真换行抛错', () => {
    assert.throws(
      () => bilingual({ zh: '第一段\n第二段', en: 'first\nsecond' }),
      /does not support newlines/,
    );
  });

  it('en 含真换行抛错', () => {
    assert.throws(
      () => bilingual({ zh: '单行', en: 'first\nsecond' }),
      /does not support newlines/,
    );
  });

  it('zh 含 ejs 标记 `<%` 抛错', () => {
    assert.throws(
      () => bilingual({ zh: '前缀 <%= 1+1 %> 后缀', en: 'safe' }),
      /must not contain ejs template markers/,
    );
  });

  it('en 含 ejs 标记 `%>` 抛错', () => {
    assert.throws(
      () => bilingual({ zh: '安全', en: 'leak %> here' }),
      /must not contain ejs template markers/,
    );
  });

  it('zh 含 `<%` 单独标记也抛错(防局部出现)', () => {
    assert.throws(
      () => bilingual({ zh: '前缀 <%= ', en: 'safe' }),
      /must not contain ejs template markers/,
    );
  });

  it('LANG_FLAG 不带 oclif default(否则未传 --lang 也会被记成 cli-flag 来源)', () => {
    // 输入编译按 flags.lang 是否为空判定 sourceKind。给 flag 设 default 'zh' 会让
    // 每一次 `omk eval` 都在 provenance 里谎称「用户显式选了语言」,并让
    // OMK_LANG / 系统 locale 解析出的语言被这个假默认覆盖。
    assert.equal((LANG_FLAG as { default?: unknown }).default, undefined);
  });
});

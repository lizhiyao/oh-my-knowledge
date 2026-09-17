/**
 * 壳层语言切换：语言是本机设置，不进地址。
 *
 * 完整 Studio 把语言收进设置抽屉；只有宿主裁掉一级导航（只挂 /measure 的评测预览宿主）时，
 * 壳层才渲染独立的切换控件。控件本身不再是链接——它写设置文件后重载当前页，所以断言的是
 * 按钮而不是 href；写设置的请求形状由 saveStudioLanguage 的纯逻辑用例钉住。
 */
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, it } from 'vitest';
import { StudioShell } from '../../../src/studio/web/components/layout/shell.js';
import { StudioNavigationProvider } from '../../../src/studio/web/components/layout/navigation.js';
import { saveStudioLanguage } from '../../../src/studio/web/components/layout/switch-language.js';

function render(lang: 'zh' | 'en', withNavigation = true): string {
  const shell = createElement(StudioShell, { lang, active: withNavigation ? 'knowledge' : false, children: '内容' });
  return renderToString(withNavigation ? shell : createElement(StudioNavigationProvider, { value: false, children: shell }));
}

describe('壳层语言切换控件', () => {
  it('完整 Studio 将语言等偏好集中到设置入口', () => {
    assert.match(render('zh'), />设置与帮助<\/span>/);
    assert.match(render('en'), />Settings and help<\/span>/);
    const html = render('zh');
    assert.doesNotMatch(html, /class="studio-lang"/);
    assert.match(html, /studio-utilities-trigger/);
    assert.doesNotMatch(html, /退出登录|订阅|剩余额度/);
  });

  it('宿主裁掉一级导航时提供写设置的切换按钮，地址不带语言参数', () => {
    const html = render('zh', false);
    assert.doesNotMatch(html, /aria-label="Studio 一级导航"/);
    assert.match(html, /<button[^>]*class="studio-lang"[^>]*aria-label="切换到英文界面"/);
    assert.doesNotMatch(html, /lang=en|lang=zh/);
  });
});

describe('saveStudioLanguage', () => {
  /** 记录两次请求，返回可编程的响应序列。 */
  function fakeFetch(responses: { ok: boolean; json?: unknown }[]) {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const next = responses.shift() ?? { ok: false };
      return { ok: next.ok, json: async () => next.json } as Response;
    }) as typeof fetch;
    return { calls, fetchImpl };
  }

  it('先读 revision 再写回：只改 language，其余设置字段原样保留', async () => {
    const { calls, fetchImpl } = fakeFetch([
      { ok: true, json: { revision: 'rev-1', settings: { schemaVersion: 1, language: 'zh', knowledge: { workspace: '/k', executor: 'codex' } } } },
      { ok: true, json: {} },
    ]);
    assert.equal(await saveStudioLanguage('en', fetchImpl), true);
    assert.equal(calls.length, 2);
    assert.deepEqual(JSON.parse(String(calls[1].init?.body)), {
      revision: 'rev-1',
      settings: { schemaVersion: 1, language: 'en', knowledge: { workspace: '/k', executor: 'codex' } },
    });
  });

  it('读取失败、保存被拒或保存冲突都返回 false，不冒充已切换', async () => {
    assert.equal(await saveStudioLanguage('en', fakeFetch([{ ok: false }]).fetchImpl), false);
    assert.equal(await saveStudioLanguage('en', fakeFetch([{ ok: true, json: { revision: 'r', settings: { schemaVersion: 1 } } }, { ok: false }]).fetchImpl), false);
    const throwing = (async () => { throw new Error('offline'); }) as typeof fetch;
    assert.equal(await saveStudioLanguage('zh', throwing), false);
  });
});

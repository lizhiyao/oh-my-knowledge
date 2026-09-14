/**
 * 壳层语言切换（#880）：随 HTML 外壳删除的 `#lang-toggle` 回到 Next 壳层。
 *
 * href 语义由纯函数锁住：切到英文只追加／替换 `lang`，切回中文删掉该参数（页面在缺少 `lang`
 * 时读到的就是中文），其余查询参数原样保留。渲染用例锁住宿主裁掉一级导航时切换控件仍然可用，
 * 以及宿主没有注入路由时不给出失效链接。
 */
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, it } from 'vitest';
import { StudioShell, languageSwitchHref } from '../../../src/studio/web/components/layout/shell.js';
import { StudioNavigationProvider } from '../../../src/studio/web/components/layout/navigation.js';
import { StudioRouteProvider } from '../../../src/studio/web/components/layout/current-route.js';

function render(lang: 'zh' | 'en', route: string, withNavigation = true): string {
  const shell = createElement(StudioShell, { lang, active: withNavigation ? 'knowledge' : false }, '内容');
  return renderToString(createElement(StudioRouteProvider, { value: route },
    withNavigation ? shell : createElement(StudioNavigationProvider, { value: false }, shell)));
}

describe('languageSwitchHref', () => {
  it('切到英文时追加 lang，并保留其余查询参数', () => {
    assert.equal(
      languageSwitchHref('/knowledge/skills/demo?doctorRun=r1', 'en'),
      '/knowledge/skills/demo?doctorRun=r1&lang=en',
    );
  });

  it('已有 lang 时替换而不是重复', () => {
    assert.equal(
      languageSwitchHref('/knowledge?lang=zh&skill=a', 'en'),
      '/knowledge?lang=en&skill=a',
    );
  });

  it('切回中文删掉 lang，页面按默认语言渲染', () => {
    assert.equal(
      languageSwitchHref('/knowledge/skills/demo?lang=en&doctorRun=r1', 'zh'),
      '/knowledge/skills/demo?doctorRun=r1',
    );
    assert.equal(languageSwitchHref('/observe?lang=en', 'zh'), '/observe');
  });

  it('保留已编码的路径，不让它退化成另一个身份', () => {
    assert.equal(
      languageSwitchHref('/knowledge/skills/audit%2F%3Cscript%3E?lang=en', 'zh'),
      '/knowledge/skills/audit%2F%3Cscript%3E',
    );
  });
});

describe('壳层语言切换控件', () => {
  it('中文页面给出英文入口，链接指回当前页并带上 lang', () => {
    const html = render('zh', '/knowledge/skills/demo?doctorRun=r1');
    assert.match(html, /class="studio-lang"[^>]+href="\/knowledge\/skills\/demo\?doctorRun=r1&amp;lang=en"/);
    assert.match(html, /aria-label="切换到英文界面"[^>]*>英文<\/a>/);
  });

  it('英文页面给出中文入口，链接不再携带 lang', () => {
    const html = render('en', '/knowledge/skills/demo?lang=en&doctorRun=r1');
    assert.match(html, /href="\/knowledge\/skills\/demo\?doctorRun=r1"/);
    assert.match(html, /aria-label="Switch to the Chinese interface"[^>]*>中文<\/a>/);
  });

  it('宿主裁掉一级导航时仍然提供语言切换', () => {
    const html = render('zh', '/measure', false);
    assert.doesNotMatch(html, /aria-label="Studio 一级导航"/);
    assert.match(html, /class="studio-lang"[^>]+href="\/measure\?lang=en"/);
  });

  it('宿主没有注入路由时不渲染切换入口', () => {
    assert.doesNotMatch(render('zh', ''), /class="studio-lang"/);
  });
});

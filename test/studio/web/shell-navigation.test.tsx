/**
 * 壳层一级导航（#903 第三项）：四区入口与品牌位的地址语义。
 *
 * 机制口径由 `test/architecture/studio-internal-navigation.test.ts` 守住（站内跳转只走 next/link，
 * 不再整文档重载）；这里锁用户实际读到的链接：地址不带语言参数（语言是本机设置，不进地址）、
 * 当前区标出 `aria-current`、品牌位跟随宿主入口。宿主裁掉页面组时导航整体不渲染，由
 * `fallback-language.test.tsx` 覆盖。
 */
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, it } from 'vitest';
import { StudioShell } from '../../../src/studio/web/components/layout/shell.js';
import { StudioNavigationProvider } from '../../../src/studio/web/components/layout/navigation.js';

type Zone = 'observe' | 'measure' | 'knowledge' | 'agents';

function render(active: Zone | false, lang: 'zh' | 'en' = 'zh', withNavigation = true): string {
  const shell = createElement(StudioShell, { lang, active, children: '内容' });
  return renderToString(withNavigation ? shell : createElement(StudioNavigationProvider, { value: false, children: shell }));
}

describe('壳层一级导航', () => {
  it('四区入口都不带语言参数，语言由本机设置决定', () => {
    const en = render('observe', 'en');
    for (const path of ['/observe', '/measure', '/knowledge', '/agents']) {
      assert.ok(en.includes(`href="${path}"`), `${path} 缺导航链接`);
    }
    assert.doesNotMatch(render('agents', 'zh'), /href="[^"]*[?&]lang=/, '站内链接不出现语言参数');
  });

  it('只给当前区标 aria-current，换区后跟着移动', () => {
    assert.match(render('measure'), /<a[^>]*aria-current="page"[^>]*href="\/measure"/);
    assert.doesNotMatch(render('measure'), /aria-current="page"[^>]*href="\/observe"/);
    assert.match(render('knowledge'), /<a[^>]*aria-current="page"[^>]*href="\/knowledge"/);
    assert.match(render('agents'), /<a[^>]*aria-current="page"[^>]*href="\/agents"/);
    assert.doesNotMatch(render('agents'), /aria-current="page"[^>]*href="\/knowledge"/);
    assert.doesNotMatch(render(false), /aria-current/, '不属于任何一区时不谎报当前位置');
  });

  it('品牌位指向宿主入口：挂了页面组从 / 进，只挂评测的宿主进评测列表', () => {
    assert.match(render('observe'), /<a[^>]*class="studio-brand"[^>]*href="\/"/);
    assert.match(render(false, 'zh', false), /<a[^>]*class="studio-brand"[^>]*href="\/measure"/);
  });

  it('侧栏头部提供收起入口；SSR 永远按展开渲染，展开按钮不进首帧文档', () => {
    const html = render('observe');
    assert.match(html, /aria-label="收起侧栏"/);
    assert.doesNotMatch(html, /aria-label="展开侧栏"/);
    assert.match(render('agents', 'en'), /aria-label="Collapse sidebar"/);
  });
});

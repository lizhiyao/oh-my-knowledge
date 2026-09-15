/**
 * 壳层一级导航（#903 第三项）：三区入口与品牌位的地址语义。
 *
 * 机制口径由 `test/architecture/studio-internal-navigation.test.ts` 守住（站内跳转只走 next/link，
 * 不再整文档重载）；这里锁用户实际读到的链接：地址显式带上当前语言、当前区标出 `aria-current`、
 * 品牌位跟随宿主入口。宿主裁掉页面组时导航整体不渲染，由 `fallback-language.test.tsx` 覆盖。
 */
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, it } from 'vitest';
import { StudioShell } from '../../../src/studio/web/components/layout/shell.js';
import { StudioNavigationProvider } from '../../../src/studio/web/components/layout/navigation.js';
import { StudioRouteProvider } from '../../../src/studio/web/components/layout/current-route.js';

type Zone = 'observe' | 'measure' | 'knowledge';

function render(active: Zone | false, lang: 'zh' | 'en' = 'zh', withNavigation = true): string {
  const shell = createElement(StudioShell, { lang, active, children: '内容' });
  return renderToString(createElement(StudioRouteProvider, { value: '/measure',
    children: withNavigation ? shell : createElement(StudioNavigationProvider, { value: false, children: shell }) }));
}

describe('壳层一级导航', () => {
  it('三区入口都显式带上当前语言，不把它交回全局偏好', () => {
    const en = render('observe', 'en');
    for (const path of ['/observe', '/measure', '/knowledge']) {
      assert.ok(en.includes(`href="${path}?lang=en"`), `${path} 缺当前语言参数`);
    }
    assert.ok(render('observe', 'zh').includes('href="/knowledge?lang=zh"'));
  });

  it('只给当前区标 aria-current，换区后跟着移动', () => {
    assert.match(render('measure'), /<a[^>]*aria-current="page"[^>]*href="\/measure\?lang=zh"/);
    assert.doesNotMatch(render('measure'), /aria-current="page"[^>]*href="\/observe\?lang=zh"/);
    assert.match(render('knowledge'), /<a[^>]*aria-current="page"[^>]*href="\/knowledge\?lang=zh"/);
    assert.doesNotMatch(render(false), /aria-current/, '不属于任何一区时不谎报当前位置');
  });

  it('品牌位指向宿主入口：挂了页面组从 / 进，只挂评测的宿主进评测列表', () => {
    assert.match(render('observe'), /<a[^>]*class="studio-brand"[^>]*href="\/\?lang=zh"/);
    assert.match(render(false, 'zh', false), /<a[^>]*class="studio-brand"[^>]*href="\/measure\?lang=zh"/);
  });
});

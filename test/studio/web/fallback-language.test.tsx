/**
 * 壳层回退页跟随请求语言（#902 §六）：三页原先硬写 `lang="zh"`，英文地址下给出中文壳层，
 * 文案还是「中文 / English」并列。语言值只有一个读取点（根布局读宿主注入的
 * `x-omk-studio-lang`），这三页作为客户端组件从同一份上下文取值。
 *
 * 反向断言是这里的主要证据：只断言英文文案出现在英文用例里，证明不了中文没有一起渲染。
 */
import assert from 'node:assert/strict';
import { createElement, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, it } from 'vitest';
import NotFound from '../../../src/studio/web/app/not-found.js';
import Loading from '../../../src/studio/web/app/loading.js';
import ErrorPage from '../../../src/studio/web/app/error.js';
import { StudioLanguageProvider } from '../../../src/studio/web/components/layout/language.js';
import type { Language } from '../../../src/studio/web/components/layout/shell.js';

function render(tree: ReactElement, lang?: Language): string {
  return renderToString(lang === undefined
    ? tree
    : createElement(StudioLanguageProvider, { value: lang }, tree));
}

const errorPage = createElement(ErrorPage, { reset: () => {} });

describe('壳层回退页的语言', () => {
  it('not-found 页在英文上下文里给出英文壳层、文案与带回语言参数的返回链接', () => {
    const en = render(createElement(NotFound), 'en');
    assert.ok(en.includes('Run not found'), en.slice(0, 300));
    assert.ok(en.includes('href="/measure?lang=en">Back to Measure<'), en.slice(0, 300));
    assert.ok(en.includes('aria-label="Studio primary navigation"'), '壳层语言必须一起切换');
    assert.ok(!en.includes('运行记录不存在') && !en.includes('返回评测'), en.slice(0, 300));

    const zh = render(createElement(NotFound), 'zh');
    assert.ok(zh.includes('href="/measure?lang=zh">返回评测<'), zh.slice(0, 300));
    assert.ok(zh.includes('aria-label="Studio 一级导航"'));
    assert.ok(!zh.includes('Run not found') && !zh.includes('Back to Measure'));
  });

  it('loading 页只给当前语言的一句加载提示', () => {
    const en = render(createElement(Loading), 'en');
    assert.match(en, /role="status"[^>]*>Loading…<\/div>/u);
    assert.doesNotMatch(en, /正在加载/u);
    const zh = render(createElement(Loading), 'zh');
    assert.match(zh, /role="status"[^>]*>正在加载…<\/div>/u);
    assert.doesNotMatch(zh, /Loading…/u);
  });

  it('error 页的标题与重试按钮跟随同一份语言', () => {
    const en = render(errorPage, 'en');
    assert.ok(en.includes('Unable to load page'), en.slice(0, 300));
    assert.ok(en.includes('>Retry<'), en.slice(0, 300));
    assert.ok(!en.includes('页面暂时无法加载') && !/重\s*试/u.test(en));

    // antd 会在两个汉字的按钮里插入空格，所以中文一侧只能用同样的宽松匹配：
    // 按 `>重试<` 断言会永远为假，而反向的 `!includes('重试')` 会永远为真。
    const zh = render(errorPage, 'zh');
    assert.ok(zh.includes('页面暂时无法加载'), zh.slice(0, 300));
    assert.ok(/重\s*试/u.test(zh), zh.slice(0, 300));
    assert.ok(!zh.includes('Unable to load page') && !zh.includes('>Retry<'));
  });

  it('宿主没给出语言时按中文兜底，而不是渲染失败', () => {
    assert.ok(render(createElement(NotFound)).includes('运行记录不存在'));
    assert.ok(render(createElement(Loading)).includes('正在加载…'));
  });
});

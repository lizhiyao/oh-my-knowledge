/**
 * 泳道标签的密度口径（#903 真实浏览器验收发现）。
 *
 * 1000×560 下四条泳道各约 55px，而标签块需要约 71px，说明文字会压到相邻泳道的名称与卡片上。
 * 这里钉住「矮泳道收掉说明」的属性口径与 CSS 侧的隐藏规则，两边不能各改一半。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it } from 'vitest';
import { SwimlaneLane } from '../../../src/studio/web/components/observe/swimlane.js';

const css = readFileSync(new URL('../../../src/studio/web/app/studio.css', import.meta.url), 'utf8');
const lane = (laneHeight: number, lang: 'zh' | 'en' = 'zh', hasCards = true): string =>
  renderToStaticMarkup(createElement(SwimlaneLane, { lane: 'action', lang, top: 32, laneHeight, hasCards }));

describe('泳道标签', () => {
  it('泳道够高时保留名称与说明', () => {
    const html = lane(160);
    assert.match(html, /data-density="normal"/);
    assert.match(html, /<strong>执行<\/strong><span>AI 发起的工具调用<\/span>/);
  });

  it('泳道矮于标签块所需高度时切到 short 档', () => {
    assert.match(lane(55), /data-density="short"/);
    assert.match(lane(72), /data-density="normal"/);
  });

  it('short 档由 CSS 收掉说明而不是留下压字的文本', () => {
    assert.match(css, /\.swimlane-label\[data-density="short"\] span\{display:none\}/);
    assert.match(css, /\.swimlane-label\{padding:8px 12px;overflow:hidden\}/);
  });

  it('英文同一口径，空泳道仍说明没有记录', () => {
    assert.match(lane(160, 'en'), /<strong>Actions<\/strong><span>AI-initiated tool calls<\/span>/);
    assert.match(lane(55, 'zh', false), /未观测到记录/);
    assert.match(lane(55, 'en', false), /No records observed/);
  });
});

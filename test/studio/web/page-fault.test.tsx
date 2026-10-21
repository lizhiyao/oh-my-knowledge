import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { projectPageFault } from '../../../src/studio/http/page-fault.js';
import { PageFaultView } from '../../../src/studio/web/components/layout/page-fault.js';

describe('Studio failure page text and actions', () => {
  it.each(['zh', 'en'] as const)('renders a source failure as a failure with actionable recovery in %s', lang => {
    const page = projectPageFault('studio_source_unavailable', 'observe', '/observe?workspace=%2Ftmp%2Fproject', true);
    const html = renderToString(createElement(PageFaultView, { page, lang }));
    expect(html).toContain(lang === 'zh' ? '暂时无法读取数据' : 'Unable to read the data');
    expect(html).toContain(lang === 'zh' ? '目前无法确认是否有记录' : 'does not establish that there are no records');
    expect(html).toContain('href="/observe?workspace=%2Ftmp%2Fproject"');
    expect(html).toContain(lang === 'zh' ? '重新读取' : 'Read again');
    expect(html).toContain('<details');
    expect(html).toContain('studio_source_unavailable');
    expect(html.match(/<a /g)).toHaveLength(1); // Returning to the same failed list would add no action.
    expect(html).not.toContain(lang === 'zh' ? 'Unable to read the data' : '暂时无法读取数据');
  });
  it('distinguishes invalid report selection from missing records and omits a useless retry', () => {
    const query = renderToString(createElement(PageFaultView, { page: projectPageFault('missing from/to query params', 'health', '/observe/health-diff', true), lang: 'zh' }));
    expect(query).toContain('请先选择要对比的报告');
    expect(query).toContain('href="/observe/health"');
    expect(query).not.toContain('重新读取');
    const missing = renderToString(createElement(PageFaultView, { page: projectPageFault('doctor_run_not_found', 'knowledge', '/knowledge/skills/a?doctorRun=stale', true), lang: 'en' }));
    expect(missing).toContain('Record not found');
    expect(missing).toContain('href="/knowledge"');
    expect(missing).toContain('doctor_run_not_found');
  });
  it('escapes external URL text rather than allowing it to add HTML attributes', () => {
    const page = projectPageFault('core_run_not_found', 'measure', '/measure/%22?workspace=%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E&x=" onmouseover="alert(1)', true);
    const html = renderToString(createElement(PageFaultView, { page, lang: 'en' }));
    expect(html).not.toContain('<script>');
    expect(html).not.toMatch(/href="[^"]*" onmouseover=/);
    expect(html).toContain('&amp;');
  });
});

'use client';
import Link from 'next/link';
import type { StudioPageFault } from '../../../view-models/page-fault';
import type { Language } from './shell';

const COPY = {
  zh: {
    unavailable: '暂时无法读取数据', missing: '找不到这条记录', query: '请先选择要对比的报告',
    unavailableReason: '数据源读取失败，目前无法确认是否有记录。请检查本机数据源是否可用，然后重新读取。',
    missingReason: '当前地址对应的记录不存在。它可能已被移除，也可能属于另一个工作区；可以返回列表核对。',
    queryReason: '这个对比地址没有同时指定两份报告。返回健康度报告列表，重新选择要对比的报告。',
    retry: '重新读取', details: '诊断信息',
    back: { observe: '返回对话列表', inbox: '返回观测收件箱', health: '返回健康度报告', measure: '返回评测记录', knowledge: '返回知识载体' },
  },
  en: {
    unavailable: 'Unable to read the data', missing: 'Record not found', query: 'Choose reports to compare',
    unavailableReason: 'The data source could not be read. This does not establish that there are no records. Check that the local source is available, then try reading it again.',
    missingReason: 'The record at this address does not exist. It may have been removed or belong to another workspace. Return to the list to check.',
    queryReason: 'This comparison address does not specify both reports. Return to the health reports and choose the reports to compare.',
    retry: 'Read again', details: 'Diagnostic information',
    back: { observe: 'Back to conversations', inbox: 'Back to observation inbox', health: 'Back to health reports', measure: 'Back to evaluations', knowledge: 'Back to knowledge artifacts' },
  },
};

export function PageFaultView({ page, lang }: { page: StudioPageFault; lang: Language }) {
  const copy = COPY[lang];
  const title = page.statusCode === 503 ? copy.unavailable : page.statusCode === 400 ? copy.query : copy.missing;
  const reason = page.statusCode === 503 ? copy.unavailableReason : page.statusCode === 400 ? copy.queryReason : copy.missingReason;
  return <section className="studio-page-fault" aria-labelledby="studio-page-fault-title">
    <div className="studio-page-fault-body">
      <p className="studio-page-fault-status">HTTP {page.statusCode}</p>
      <h1 id="studio-page-fault-title">{title}</h1>
      <p className="studio-page-fault-reason">{reason}</p>
      <div className="studio-page-fault-actions">
        {page.retryHref ? <Link className="studio-page-fault-primary" href={page.retryHref} prefetch={false}
          // Recovery must re-read the source even when the URL is unchanged or Next cached its failed RSC payload.
          onNavigate={event => { event.preventDefault(); window.location.assign(page.retryHref!); }}
        >{copy.retry}</Link> : null}
        {page.returnHref !== page.retryHref ? <Link className={page.retryHref ? 'studio-page-fault-secondary' : 'studio-page-fault-primary'} href={page.returnHref} prefetch={false}>{copy.back[page.returnTo]}</Link> : null}
      </div>
      <details className="studio-page-fault-diagnostic"><summary>{copy.details}</summary><code>{page.faultCode}</code></details>
    </div>
  </section>;
}

import { buildObservationInboxViewModel, type ObservationInboxViewModel } from '../../observability/inbox/view-model.js';

export type InboxPage = {
  readonly pageKind: 'inbox';
  readonly model: ObservationInboxViewModel;
};

/**
 * 观测收件箱 Next 页面的数据桥接（#839 批次 1）。
 * 投影仍由 observability/inbox/view-model.ts 提供，React 不引入第二份业务语义。
 * 目录不可读等数据源失败在此抛出，由 next-server 统一投影为 503。
 */
export function loadInboxPage(observationsDir: string, skill: string | undefined): InboxPage {
  return { pageKind: 'inbox', model: buildObservationInboxViewModel(observationsDir, { skill }) };
}

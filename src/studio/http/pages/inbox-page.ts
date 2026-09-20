import { buildObservationInboxViewModel, type ObservationInboxViewModel } from '../../../observability/application.js';
import { OBSERVE_INBOX_PATH } from '../page-paths.js';

export type InboxPage = {
  readonly pageKind: 'inbox';
  readonly model: ObservationInboxViewModel;
};

/** 地址识别属装载器；宿主只按 `observationInbox` 开关决定接不接管这一页。 */
export function isInboxPath(path: string): boolean {
  return path === OBSERVE_INBOX_PATH;
}

/**
 * 观测收件箱 Next 页面的数据桥接（#839 批次 1）。
 * 投影仍由 observability/inbox/view-model.ts 提供，React 不引入第二份业务语义。
 * 目录不可读等数据源失败在此抛出，由 next-server 统一投影为 503。
 */
export function loadInboxPage(observationsDir: string | undefined, skill: string | undefined): InboxPage {
  return { pageKind: 'inbox', model: buildObservationInboxViewModel(observationsDir, { skill }) };
}

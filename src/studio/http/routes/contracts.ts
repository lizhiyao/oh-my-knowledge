import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Lang } from '../../../shared/language.js';

export interface StudioRouteContext {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly url: URL;
  readonly path: string;
  /** 本请求的展示语言（注入头优先，否则本机设置），供只读投影复用同一口径。 */
  readonly lang: Lang;
}

export interface LiveStreamRegistry {
  add(close: () => void): void;
  delete(close: () => void): void;
}

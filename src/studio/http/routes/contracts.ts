import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Lang } from '../../../shared/language.js';

export interface StudioRouteContext {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly url: URL;
  readonly path: string;
  readonly lang: Lang;
}

export type StudioRouteHandler = (
  context: StudioRouteContext,
) => boolean | Promise<boolean>;

export interface LiveStreamRegistry {
  add(close: () => void): void;
  delete(close: () => void): void;
}

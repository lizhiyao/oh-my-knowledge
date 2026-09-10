import type { IncomingMessage, ServerResponse } from 'node:http';

/** Optional app renderer owned by the listener lifecycle. */
export interface StudioPresentation {
  prepare(): Promise<void>;
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
  close(): Promise<void>;
}

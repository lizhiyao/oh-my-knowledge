import type { IncomingMessage, ServerResponse } from 'node:http';

export interface StudioRouteContext {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly url: URL;
  readonly path: string;
}

export interface LiveStreamRegistry {
  add(close: () => void): void;
  delete(close: () => void): void;
}

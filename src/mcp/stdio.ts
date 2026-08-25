#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { FileObservationFeedbackStore } from './feedback-store.js';
import { createObservationMcpServer } from './mcp-server.js';
import { LOCAL_OBSERVATION_PRINCIPAL } from './principal.js';

async function main(): Promise<void> {
  const server = createObservationMcpServer({
    principal: LOCAL_OBSERVATION_PRINCIPAL,
    captureStore: new FileObservationFeedbackStore({ partition: 'shared' }),
  });
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

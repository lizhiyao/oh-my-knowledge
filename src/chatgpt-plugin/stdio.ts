#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { FileObservationCaptureStore } from './capture-store.js';
import { createChatGptObservationMcpServer } from './mcp-server.js';
import { LOCAL_OBSERVATION_PRINCIPAL } from './principal.js';

async function main(): Promise<void> {
  const server = createChatGptObservationMcpServer({
    principal: LOCAL_OBSERVATION_PRINCIPAL,
    captureStore: new FileObservationCaptureStore({ partition: 'shared' }),
  });
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

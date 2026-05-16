#!/usr/bin/env node
// Production entry — loads compiled commands from dist/.
// Run via `node bin/run.js <command>` or after `npm link` as `omk-spike <command>`.

async function main() {
  const { execute } = await import('@oclif/core');
  await execute({ dir: import.meta.url });
}

await main();

#!/usr/bin/env node
// Development entry — must be invoked via `node --import tsx bin/dev.js`
// (use the `yarn dev` script). tsx provides on-the-fly TS loading so src/
// is run directly without `yarn build`. oclif's development:true flag maps
// `oclif.commands = "./dist/commands"` over to `./src/commands` at lookup time.

import { execute } from '@oclif/core';

await execute({ development: true, dir: import.meta.url });

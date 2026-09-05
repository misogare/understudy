#!/usr/bin/env node
import { main } from '../src/cli.js';

main().catch((e) => {
  process.stderr.write(`understudy: ${e?.stack || e}\n`);
  process.exit(1);
});

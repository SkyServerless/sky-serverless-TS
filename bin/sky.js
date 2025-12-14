#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const distPath = path.join(__dirname, "../dist/cli/index.js");
if (fs.existsSync(distPath)) {
  require(distPath);
} else {
  try {
    require("ts-node/register/transpile-only");
  } catch (error) {
    console.error("[sky] Compiled CLI not found and ts-node is unavailable.");
    console.error('[sky] Run "npm run build:cli" to generate dist/cli/index.js.');
    process.exit(1);
  }
  require("../src/cli/index");
}

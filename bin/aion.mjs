#!/usr/bin/env node
import { main } from "../src/index.mjs";

main(process.argv.slice(2)).catch((err) => {
  console.error("\x1b[31m✖ Fatal:\x1b[0m", err?.message || err);
  process.exit(1);
});

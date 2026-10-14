#!/usr/bin/env node
import { VERSION } from "../src/version.js";

const args = process.argv.slice(2);
if (args.length === 1 && ["--version", "-v", "-V"].includes(args[0])) {
  process.stdout.write(VERSION + "\n");
} else {
  const { main } = await import("../src/cli.js");
  await main();
}

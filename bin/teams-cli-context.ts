#!/usr/bin/env node
// SessionStart hook entrypoint: prints a tiny unread summary and always exits 0.
import { sessionContext } from "../src/context.js";

process.stdout.write(`${await sessionContext()}\n`);

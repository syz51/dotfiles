#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";
import { openCodeApiFixture } from "./opencode.js";
const args = process.argv.slice(2);
if (process.env.FAKE_OPENCODE_LOG) appendFileSync(process.env.FAKE_OPENCODE_LOG, JSON.stringify(args) + "\n");
if (args[0] !== "api" || args[1] !== "get") process.exit(2);
if (process.env.FAKE_OPENCODE_FAIL) { console.error("private credential and transcript must not leak"); process.exit(1); }
const entries = process.env.FAKE_OPENCODE_DATA ? JSON.parse(readFileSync(process.env.FAKE_OPENCODE_DATA, "utf8")) : [];
console.log(JSON.stringify(await openCodeApiFixture(entries, { pageSize: 2 })(args[2])));

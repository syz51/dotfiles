#!/usr/bin/env bun
// A stand-in for the `board` binary in the board-format benchmark's tests. Appends
// { who: "board", args, cwd, stdin, env } as a JSON line to FAKE_LOG and:
//   snapshot --help        prints the experimental --framing option
//   admin device ...       prints a token on stdout (FAKE_BOARD_DEVICE_EXIT fails it)
//   serve --config <file>  answers /healthz on the file's listen port until killed
//   add                    prints the new task (FAKE_BOARD_ADD_ID, default demo-3), as
//                          JSON with --json
//   anything else          exits FAKE_BOARD_EXIT (default 0)
import { appendFileSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const env = process.env;
const serving = args[0] === "serve";
const stdin = serving || args.includes("--help") || args[0] === "admin" ? "" : await Bun.stdin.text();
if (env.FAKE_LOG)
  appendFileSync(env.FAKE_LOG, `${JSON.stringify({ who: "board", args, cwd: process.cwd(), stdin, env: { BOARD_HOME: env.BOARD_HOME, BOARD_KEYCHAIN: env.BOARD_KEYCHAIN, BOARD_TOKEN: env.BOARD_TOKEN } })}\n`);

if (args[0] === "snapshot" && args.includes("--help")) {
  console.log("      --framing <FRAMING>  quoted, bare or datamarked");
} else if (args[0] === "admin") {
  if (env.FAKE_BOARD_DEVICE_EXIT) {
    console.error("no database");
    process.exit(Number(env.FAKE_BOARD_DEVICE_EXIT));
  }
  console.log("fake-token-0123");
  console.error("board: device bench created");
} else if (serving) {
  const config = readFileSync(args[args.indexOf("--config") + 1], "utf8");
  const port = Number(config.match(/listen = "127\.0\.0\.1:(\d+)"/)[1]);
  Bun.serve({ hostname: "127.0.0.1", port, fetch: (request) => new URL(request.url).pathname === "/healthz" ? Response.json({ ok: true }) : new Response("no", { status: 404 }) });
  if (env.FAKE_LOG) appendFileSync(env.FAKE_LOG, `${JSON.stringify({ who: "server", pid: process.pid })}\n`);
} else {
  // `add` prints the new task's id as the real CLI does.
  const add = args.indexOf("add");
  if (add >= 0 && args[0] === "--agent") {
    const id = env.FAKE_BOARD_ADD_ID ?? "demo-3";
    console.log(args.includes("--json") ? JSON.stringify({ id, title: args[add + 1] }) : `added ${id} open p2 "${args[add + 1]}" ready`);
  }
  process.exit(Number(env.FAKE_BOARD_EXIT ?? 0));
}

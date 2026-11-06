// Approves the Codex hooks this repository tracks, as Codex's own hook review would.
//
//   bun ~/.config/codex/trust-hooks.js           # list hooks and their trust status
//   bun ~/.config/codex/trust-hooks.js --trust   # approve untrusted or modified tracked hooks
//
// Codex runs a new or changed hook only after it is approved, and stores the approval as
// `hooks.state."<key>".trusted_hash` in ~/.codex/config.toml. This asks `codex app-server`
// for the hooks (`hooks/list`) and writes the approvals through `config/batchWrite`, the
// calls Codex's TUI makes. It approves hooks loaded from $CODEX_HOME/hooks.json only while
// that file matches codex/hooks.json on origin/main, which changes through reviewed PRs;
// ~/.codex/hooks.json links to this checkout, so its working copy proves nothing.
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

const TIMEOUT_MS = 30_000;
const REPO = join(import.meta.dir, "..");

// codex/hooks.json as merged into origin/main.
export function reviewedHooks(repo = REPO) {
  return JSON.parse(execFileSync("git", ["-C", repo, "show", "origin/main:codex/hooks.json"], { encoding: "utf8" }));
}

// Hooks to approve: loaded from the user's hooks file and not yet trusted.
export function hooksToTrust(hooks, hooksFile) {
  return hooks.filter((hook) =>
    (hook.trustStatus === "untrusted" || hook.trustStatus === "modified") &&
    hook.key.startsWith(`${hooksFile}:`));
}

function appServer(bin) {
  const child = spawn(bin, ["app-server"], { stdio: ["pipe", "pipe", "inherit"] });
  const waiting = new Map();
  let failure = null;
  let buffer = "";
  let next = 1;
  const fail = (error) => {
    failure ??= error;
    for (const { reject } of waiting.values()) reject(failure);
    waiting.clear();
  };
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  child.on("error", (error) => fail(new Error(`codex app-server (${bin}): ${error.message}`)));
  child.stdin.on("error", (error) => fail(new Error(`codex app-server stdin: ${error.message}`)));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let newline; (newline = buffer.indexOf("\n")) >= 0;) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        process.stderr.write(`codex app-server printed a non-JSON line: ${line.slice(0, 200)}\n`);
        continue;
      }
      // A request from the server shares the id space with responses; decline it.
      if (message.method !== undefined) {
        if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: "not supported by trust-hooks" } });
        continue;
      }
      const pending = waiting.get(message.id);
      if (!pending) continue;
      waiting.delete(message.id);
      if (message.error) pending.reject(new Error(`${pending.method}: ${JSON.stringify(message.error)}`));
      else pending.resolve(message.result);
    }
  });
  // close, not exit: it fires after the last stdout chunk was read.
  child.on("close", (code) => fail(new Error(`codex app-server exited (${code})`)));
  return {
    notify: (method) => send({ method }),
    request(method, params) {
      if (failure) return Promise.reject(failure);
      const id = next++;
      send({ id, method, params });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${method} timed out`)), TIMEOUT_MS);
        waiting.set(id, {
          method,
          resolve: (value) => (clearTimeout(timer), resolve(value)),
          reject: (error) => (clearTimeout(timer), reject(new Error(`${error.message} during ${method}`))),
        });
      });
    },
    close: () => child.kill(),
  };
}

// Returns the exit status: 0 when nothing needs attention, 1 when hooks stay unapproved or
// Codex reported problems loading them.
export async function main(argv, {
  home = homedir(),
  codexHome = process.env.CODEX_HOME || join(home, ".codex"),
  codex = process.env.CODEX_BIN || "codex",
  reviewed = reviewedHooks,
  log = console.log,
} = {}) {
  const trust = argv.includes("--trust");
  const hooksFile = join(codexHome, "hooks.json");
  const matches = isDeepStrictEqual(JSON.parse(readFileSync(hooksFile, "utf8")), reviewed());
  const server = appServer(codex);
  try {
    await server.request("initialize", { clientInfo: { name: "dotfiles-trust-hooks", title: "dotfiles trust-hooks", version: "1" } });
    server.notify("initialized");
    const { data } = await server.request("hooks/list", { cwds: [home] });
    let problems = 0;
    for (const entry of data) {
      for (const [kind, items] of [["warning", entry.warnings], ["error", entry.errors]]) {
        for (const item of items ?? []) {
          problems++;
          log(`${kind}\t${typeof item === "string" ? item : JSON.stringify(item)}`);
        }
      }
    }
    const hooks = data.flatMap((entry) => entry.hooks ?? []);
    const pending = hooksToTrust(hooks, hooksFile);
    const approve = matches ? pending : [];
    for (const hook of hooks) log(`${hook.trustStatus}\t${hook.command ?? hook.handlerType ?? hook.key}${approve.includes(hook) ? (trust ? "\t(approving)" : "\t(tracked; --trust approves)") : ""}`);
    if (!matches && pending.length) log(`${hooksFile} differs from codex/hooks.json on origin/main; merge the change, pull, then run this again`);
    if (trust && approve.length) {
      await server.request("config/batchWrite", {
        edits: [{
          keyPath: "hooks.state",
          value: Object.fromEntries(approve.map((hook) => [hook.key, { trusted_hash: hook.currentHash }])),
          mergeStrategy: "upsert",
        }],
        filePath: null,
        expectedVersion: null,
        reloadUserConfig: true,
      });
      log(`approved ${approve.length} hooks`);
    }
    return problems || (pending.length && !(trust && matches)) ? 1 : 0;
  } finally {
    server.close();
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));

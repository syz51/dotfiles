// Approves the Codex hooks this repository tracks, as Codex's own hook review would.
//
//   bun ~/.config/codex/trust-hooks.js           # list hooks and their trust status
//   bun ~/.config/codex/trust-hooks.js --trust   # approve untrusted or modified tracked hooks
//
// Codex runs a new or changed hook only after it is approved, and stores the approval as
// `hooks.state."<key>".trusted_hash` in ~/.codex/config.toml. This asks `codex app-server`
// for the hooks (`hooks/list`) and writes the approvals through `config/batchWrite`, the
// calls Codex's TUI makes. It approves only hooks loaded from ~/.codex/hooks.json whose
// command is in this repository's codex/hooks.json, which changes through reviewed PRs.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TIMEOUT_MS = 30_000;

export function trackedCommands(path) {
  const { hooks } = JSON.parse(readFileSync(path, "utf8"));
  return new Set(Object.values(hooks).flatMap((groups) => groups.flatMap((group) => group.hooks.map((hook) => hook.command))));
}

// Hooks to approve: loaded from the user's hooks.json, tracked, and not yet trusted.
export function hooksToTrust(hooks, tracked, hooksFile) {
  return hooks.filter((hook) =>
    (hook.trustStatus === "untrusted" || hook.trustStatus === "modified") &&
    hook.key.startsWith(`${hooksFile}:`) &&
    tracked.has(hook.command));
}

function appServer(bin) {
  const child = spawn(bin, ["app-server"], { stdio: ["pipe", "pipe", "inherit"] });
  const waiting = new Map();
  let buffer = "";
  let next = 1;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let newline; (newline = buffer.indexOf("\n")) >= 0;) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const pending = waiting.get(message.id);
      if (!pending) continue;
      waiting.delete(message.id);
      if (message.error) pending.reject(new Error(`${pending.method}: ${JSON.stringify(message.error)}`));
      else pending.resolve(message.result);
    }
  });
  child.on("exit", (code) => {
    for (const { method, reject } of waiting.values()) reject(new Error(`codex app-server exited (${code}) during ${method}`));
    waiting.clear();
  });
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  return {
    notify: (method) => send({ method }),
    request(method, params) {
      const id = next++;
      send({ id, method, params });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${method} timed out`)), TIMEOUT_MS);
        waiting.set(id, {
          method,
          resolve: (value) => (clearTimeout(timer), resolve(value)),
          reject: (error) => (clearTimeout(timer), reject(error)),
        });
      });
    },
    close: () => child.kill(),
  };
}

export async function main(argv, { home = homedir(), codex = process.env.CODEX_BIN || "codex", log = console.log } = {}) {
  const trust = argv.includes("--trust");
  const hooksFile = join(home, ".codex/hooks.json");
  const tracked = trackedCommands(join(import.meta.dir, "hooks.json"));
  const server = appServer(codex);
  try {
    await server.request("initialize", { clientInfo: { name: "dotfiles-trust-hooks", title: "dotfiles trust-hooks", version: "1" } });
    server.notify("initialized");
    const { data } = await server.request("hooks/list", { cwds: [home] });
    const hooks = data.flatMap((entry) => entry.hooks ?? []);
    const approve = hooksToTrust(hooks, tracked, hooksFile);
    for (const hook of hooks) log(`${hook.trustStatus}\t${hook.command}${approve.includes(hook) ? (trust ? "\t(approving)" : "\t(tracked; --trust approves)") : ""}`);
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
    return approve.length;
  } finally {
    server.close();
  }
}

if (import.meta.main) await main(process.argv.slice(2));

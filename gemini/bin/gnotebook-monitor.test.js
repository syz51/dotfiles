import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildLaunchAgentPlist,
  diffSnapshots,
  formatReleaseTask,
  loadState,
  parseDiscoverySnapshot,
  parseMcpToolsHtml,
  parseMonitorCli,
  parseRoadmapHtml,
  runCheck,
} from "./gnotebook-monitor.js";

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "gnotebook-monitor-test-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SAMPLE_DISCOVERY_V1 = {
  name: "notebook",
  version: "v1",
  revision: "20261121",
  auth: {
    oauth2: {
      scopes: {
        "https://www.googleapis.com/auth/notebook": { description: "Manage notebooks" },
      },
    },
  },
  resources: {
    notebooks: {
      methods: {
        create: { httpMethod: "POST", flatPath: "v1/notebooks" },
        list: { httpMethod: "GET", flatPath: "v1/notebooks" },
      },
      resources: {
        sources: {
          methods: {
            create: { httpMethod: "POST", flatPath: "v1/notebooks/{notebooksId}/sources" },
          },
        },
      },
    },
    media: {
      methods: {
        upload: {
          httpMethod: "POST",
          flatPath: "v1/notebooks/{notebooksId}/sources:upload",
          supportsMediaUpload: true,
        },
      },
    },
  },
  schemas: {
    Notebook: { properties: { name: {}, displayName: {}, createTime: {} } },
    Source: { properties: { name: {}, state: {}, textContent: {}, webContent: {} } },
  },
};

const SAMPLE_MCP_HTML = `
<html><body>
<h2 id="available-mcp-tools" tabindex="-1">Available MCP tools</h2>
<table>
<thead><tr><th>Tool name</th><th>Description</th></tr></thead>
<tbody>
<tr><td><code translate="no">create_notebook</code></td><td>Creates a notebook.</td></tr>
<tr><td><code translate="no">list_notebooks</code></td><td>Lists notebooks.</td></tr>
<tr><td><code translate="no">create_source</code></td><td>Creates a source.</td></tr>
</tbody>
</table>
</body></html>
`;

const SAMPLE_ROADMAP_HTML = `
<html><body>
<div class="devsite-article-body clearfix">
<p>The following capabilities are on our roadmap:</p>
<ul>
<li>Supporting Google Workspace accounts</li>
<li>Supporting deleting notebooks &amp; sources</li>
<li>Generating artifacts</li>
</ul>
</div>
</body></html>
`;

function makeMockFetch({
  discovery = SAMPLE_DISCOVERY_V1,
  mcpHtml = SAMPLE_MCP_HTML,
  roadmapHtml = SAMPLE_ROADMAP_HTML,
  liveVersions = [],
  discoveryStatus = 200,
} = {}) {
  return async (url) => {
    const u = String(url);
    if (u.endsWith("$discovery/rest?version=v1")) {
      if (discoveryStatus !== 200) {
        return new Response("err", { status: discoveryStatus });
      }
      return new Response(JSON.stringify(discovery), { status: 200 });
    }
    for (const ver of ["v1alpha", "v1beta", "v1beta1", "v2"]) {
      if (u.endsWith(`version=${ver}`)) {
        if (liveVersions.includes(ver)) {
          return new Response(JSON.stringify({ name: "notebook", version: ver }), { status: 200 });
        }
        return new Response("Not Found", { status: 404 });
      }
    }
    if (u.includes("/docs/mcp")) {
      return new Response(mcpHtml, { status: 200 });
    }
    if (u.includes("/docs/roadmap")) {
      return new Response(roadmapHtml, { status: 200 });
    }
    return new Response("Not Found", { status: 404 });
  };
}

describe("gnotebook-monitor parsers and diffing", () => {
  test("parseDiscoverySnapshot extracts nested methods, schema fields, and scopes", () => {
    const snap = parseDiscoverySnapshot(SAMPLE_DISCOVERY_V1);
    expect(snap.revision).toBe("20261121");
    expect(Object.keys(snap.methods)).toEqual([
      "media.upload",
      "notebooks.create",
      "notebooks.list",
      "notebooks.sources.create",
    ]);
    expect(snap.methods["media.upload"].supportsMediaUpload).toBe(true);
    expect(snap.schemas.Source).toEqual(["name", "state", "textContent", "webContent"]);
    expect(snap.scopes).toEqual(["https://www.googleapis.com/auth/notebook"]);
  });

  test("parseMcpToolsHtml and parseRoadmapHtml extract structured items and return null on missing markup", () => {
    expect(parseMcpToolsHtml(SAMPLE_MCP_HTML)).toEqual([
      "create_notebook",
      "create_source",
      "list_notebooks",
    ]);
    expect(parseMcpToolsHtml("<html><body>no table</body></html>")).toBeNull();

    expect(parseRoadmapHtml(SAMPLE_ROADMAP_HTML)).toEqual([
      "Supporting Google Workspace accounts",
      "Supporting deleting notebooks & sources",
      "Generating artifacts",
    ]);
    // Must survive nested <div> wrappers before <ul> inside devsite-article-body
    const nestedRoadmap = `
      <article>
      <div class="devsite-article-body clearfix">
        <div class="banner">Preview notice</div>
        <ul><li>Item A</li><li>Item B</li></ul>
      </div>
      </article>
      <nav><ul><li>Should not be parsed</li></ul></nav>
    `;
    expect(parseRoadmapHtml(nestedRoadmap)).toEqual(["Item A", "Item B"]);
    // Must return null instead of falling back to nav lists when devsite-article-body is absent
    expect(parseRoadmapHtml("<html><body><nav><ul><li>Nav Link</li></ul></nav></body></html>")).toBeNull();
  });

  test("diffSnapshots ignores revision-only bumps and detects structural API/MCP/roadmap changes", () => {
    const base = {
      discovery: parseDiscoverySnapshot(SAMPLE_DISCOVERY_V1),
      probeVersions: [],
      mcpTools: ["create_notebook", "list_notebooks"],
      roadmapItems: ["Supporting deleting notebooks and sources", "Generating artifacts"],
    };

    const revOnly = {
      ...base,
      discovery: { ...base.discovery, revision: "20261201" },
    };
    expect(diffSnapshots(base, revOnly).hasChanges).toBe(false);

    const updatedDoc = structuredClone(SAMPLE_DISCOVERY_V1);
    updatedDoc.revision = "20261210";
    updatedDoc.resources.notebooks.methods.delete = {
      httpMethod: "DELETE",
      flatPath: "v1/notebooks/{notebooksId}",
    };
    updatedDoc.schemas.Source.properties.driveContent = {};
    const next = {
      discovery: parseDiscoverySnapshot(updatedDoc),
      probeVersions: ["v1beta"],
      mcpTools: ["create_notebook", "delete_notebook", "list_notebooks"],
      roadmapItems: ["Generating artifacts"],
    };

    const diff = diffSnapshots(base, next);
    expect(diff.hasChanges).toBe(true);
    expect(diff.addedMethods).toEqual([
      { method: "notebooks.delete", spec: "DELETE v1/notebooks/{notebooksId}" },
    ]);
    expect(diff.addedSchemaFields).toEqual(["Source.driveContent"]);
    expect(diff.addedVersions).toEqual(["v1beta"]);
    expect(diff.addedMcpTools).toEqual(["delete_notebook"]);
    expect(diff.removedRoadmapItems).toEqual(["Supporting deleting notebooks and sources"]);
    expect(diff.changeKey).toMatch(/^[a-f0-9]{16}$/);

    const task = formatReleaseTask(diff, base, next);
    expect(task.title.length).toBeLessThanOrEqual(80);
    expect(task.body).toContain(`gnotebook-api:${diff.changeKey}`);
    expect(task.body).toContain("notebooks.delete");
    expect(task.body).toContain("Source.driveContent");
  });

  test("buildLaunchAgentPlist produces valid escaped XML and parseMonitorCli validates flags", () => {
    const plist = buildLaunchAgentPlist({
      bunPath: "/Users/test/.bun/bin/bun",
      scriptPath: "/Users/test/.config/gemini/bin/gnotebook-monitor.js",
      stateDir: "/Users/test/.local/state/gnotebook-monitor",
      searchPath: "/Users/test/.cargo/bin:/Users/test/.bun/bin:/usr/bin",
    });
    expect(plist).toContain("<string>com.syz51.gnotebook-monitor</string>");
    expect(plist).toContain("<integer>604800</integer>");
    expect(plist).toContain("<string>check</string>");
    expect(plist).toContain("<string>--state-dir</string>");
    expect(plist).toContain("<string>/Users/test/.local/state/gnotebook-monitor</string>");
    expect(plist).toContain(".cargo/bin");

    expect(parseMonitorCli(["check", "--dry-run", "--json"]).opts.dryRun).toBe(true);
    expect(() => parseMonitorCli(["install", "--interval", "60"])).toThrow("at least 300");
    expect(() => parseMonitorCli(["check", "--state-dir"])).toThrow("--state-dir requires");
    expect(() => parseMonitorCli(["check", "--bogus"])).toThrow("Unknown flag");
  });
});

describe("gnotebook-monitor end-to-end check lifecycle", () => {
  test("seeds baseline on first run, stays silent on unchanged, files once on release, and dedupes across Macs", async () => {
    await withTempDir(async (stateDir) => {
      const calls = [];
      const runner = (args) => {
        calls.push(args);
        if (args.includes("ls")) return { status: 0, stdout: "[]", stderr: "" };
        if (args.includes("add")) return { status: 0, stdout: '{"id":"dotfiles-999"}', stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      };

      // Run 1: seed baseline without filing
      const r1 = await runCheck({
        stateDir,
        fetchImpl: makeMockFetch(),
        runCommand: runner,
        boardPath: "/bin/board",
        now: new Date("2026-11-24T00:00:00Z"),
      });
      expect(r1.status).toBe("initialized");
      expect(calls.length).toBe(0);

      // Run 2: revision bump only -> silent
      const revBump = structuredClone(SAMPLE_DISCOVERY_V1);
      revBump.revision = "20261125";
      const r2 = await runCheck({
        stateDir,
        fetchImpl: makeMockFetch({ discovery: revBump }),
        runCommand: runner,
        boardPath: "/bin/board",
        now: new Date("2026-11-25T00:00:00Z"),
      });
      expect(r2.status).toBe("unchanged");
      expect(calls.length).toBe(0);
      expect(loadState(stateDir).snapshot.discovery.revision).toBe("20261125");

      // Run 3: new delete endpoint ships -> files exactly 1 board task
      const withDelete = structuredClone(revBump);
      withDelete.revision = "20261201";
      withDelete.resources.notebooks.methods.delete = {
        httpMethod: "DELETE",
        flatPath: "v1/notebooks/{notebooksId}",
      };
      const r3 = await runCheck({
        stateDir,
        fetchImpl: makeMockFetch({ discovery: withDelete }),
        runCommand: runner,
        boardPath: "/bin/board",
        now: new Date("2026-12-01T00:00:00Z"),
      });
      expect(r3.ok).toBe(true);
      expect(r3.status).toBe("release-detected");
      expect(r3.channel).toBe("board");
      expect(r3.taskId).toBe("dotfiles-999");
      const addCall = calls.find((c) => c.includes("add"));
      expect(addCall).toBeDefined();
      expect(addCall).toContain("--agent");
      expect(addCall).toContain("claude:gnotebook-monitor");
      expect(addCall).toContain("--register");

      // Run 4: same updated API -> unchanged, no second task
      const prevCalls = calls.length;
      const r4 = await runCheck({
        stateDir,
        fetchImpl: makeMockFetch({ discovery: withDelete }),
        runCommand: runner,
        boardPath: "/bin/board",
        now: new Date("2026-12-01T12:00:00Z"),
      });
      expect(r4.status).toBe("unchanged");
      expect(calls.length).toBe(prevCalls);

      const events = readFileSync(join(stateDir, "events.jsonl"), "utf8").trim().split("\n");
      expect(events.length).toBe(2); // initialized + release-detected
    });
  });

  test("cross-Mac board dedupe skips add when another host already filed the changeKey", async () => {
    await withTempDir(async (stateDir) => {
      await runCheck({
        stateDir,
        fetchImpl: makeMockFetch(),
        runCommand: () => ({ status: 0, stdout: "", stderr: "" }),
        boardPath: "/bin/board",
      });

      const withV2 = structuredClone(SAMPLE_DISCOVERY_V1);
      withV2.resources.notebooks.methods.query = {
        httpMethod: "POST",
        flatPath: "v1/notebooks/{notebooksId}:query",
      };
      const expectedKey = diffSnapshots(
        loadState(stateDir).snapshot,
        {
          ...loadState(stateDir).snapshot,
          discovery: parseDiscoverySnapshot(withV2),
        },
      ).changeKey;

      const calls = [];
      const runner = (args) => {
        calls.push(args);
        if (args.includes("ls")) {
          return {
            status: 0,
            stdout: JSON.stringify([
              { id: "dotfiles-888", title: "Existing", body: `marker gnotebook-api:${expectedKey}` },
            ]),
            stderr: "",
          };
        }
        return { status: 0, stdout: "", stderr: "" };
      };

      const res = await runCheck({
        stateDir,
        fetchImpl: makeMockFetch({ discovery: withV2 }),
        runCommand: runner,
        boardPath: "/bin/board",
      });
      expect(res.ok).toBe(true);
      expect(res.channel).toBe("board-deduped");
      expect(res.taskId).toBe("dotfiles-888");
      expect(calls.some((c) => c.includes("add"))).toBe(false);
    });
  });

  test("preserves baseline on board add failure or network failure so alerts are never lost", async () => {
    await withTempDir(async (stateDir) => {
      await runCheck({
        stateDir,
        fetchImpl: makeMockFetch(),
        runCommand: () => ({ status: 0, stdout: "", stderr: "" }),
        boardPath: "/bin/board",
      });

      // Network error preserves baseline
      const netErr = await runCheck({
        stateDir,
        fetchImpl: makeMockFetch({ discoveryStatus: 503 }),
        runCommand: () => ({ status: 0, stdout: "", stderr: "" }),
        boardPath: "/bin/board",
      });
      expect(netErr.ok).toBe(false);
      expect(netErr.status).toBe("fetch-error");
      expect(loadState(stateDir).snapshot.discovery.revision).toBe("20261121");

      // Board add failure does NOT advance baseline or mark reported
      const withArtifacts = structuredClone(SAMPLE_DISCOVERY_V1);
      withArtifacts.resources.notebooks.methods.generateArtifact = {
        httpMethod: "POST",
        flatPath: "v1/notebooks/{notebooksId}:generateArtifact",
      };
      const failBoard = await runCheck({
        stateDir,
        fetchImpl: makeMockFetch({ discovery: withArtifacts }),
        runCommand: (args) =>
          args.includes("add")
            ? { status: 1, stdout: "", stderr: "board: no device token" }
            : { status: 1, stdout: "", stderr: "board: no device token" },
        boardPath: "/bin/board",
      });
      expect(failBoard.ok).toBe(false);
      expect(failBoard.status).toBe("report-failed");
      expect(loadState(stateDir).reportedChangeKeys).toEqual([]);
      expect(loadState(stateDir).snapshot.discovery.methods["notebooks.generateArtifact"]).toBeUndefined();
    });
  });

  test("preserves live probeVersions on transient 503 and reports Removed API versions on confirmed 404", async () => {
    await withTempDir(async (stateDir) => {
      const calls = [];
      const runner = (args) => {
        calls.push(args);
        if (args.includes("ls")) return { status: 0, stdout: "[]", stderr: "" };
        if (args.includes("add")) return { status: 0, stdout: '{"id":"dotfiles-901"}', stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      };

      // Seed baseline with v1beta live
      await runCheck({
        stateDir,
        fetchImpl: makeMockFetch({ liveVersions: ["v1beta"] }),
        runCommand: runner,
        boardPath: "/bin/board",
      });
      expect(loadState(stateDir).snapshot.probeVersions).toEqual(["v1beta"]);

      // Transient 503 on v1beta probe must NOT fire a false removedVersions alert
      const flakyFetch = async (url) => {
        if (String(url).includes("version=v1beta")) {
          return new Response("Unavailable", { status: 503 });
        }
        return makeMockFetch({ liveVersions: ["v1beta"] })(url);
      };
      const rFlaky = await runCheck({
        stateDir,
        fetchImpl: flakyFetch,
        runCommand: runner,
        boardPath: "/bin/board",
      });
      expect(rFlaky.status).toBe("unchanged");
      expect(rFlaky.warnings.some((w) => w.includes("probe v1beta: HTTP 503"))).toBe(true);
      expect(calls.length).toBe(0);

      // Confirmed 404 on v1beta files a task that explicitly lists Removed API versions
      const rRemoved = await runCheck({
        stateDir,
        fetchImpl: makeMockFetch({ liveVersions: [] }),
        runCommand: runner,
        boardPath: "/bin/board",
      });
      expect(rRemoved.status).toBe("release-detected");
      const addCall = calls.find((c) => c.includes("add"));
      const bodyIdx = addCall.indexOf("--body");
      expect(addCall[bodyIdx + 1]).toContain("### Removed API versions");
      expect(addCall[bodyIdx + 1]).toContain("`v1beta`");
      const osaCall = calls.find((c) => c[0] === "/usr/bin/osascript");
      if (process.platform === "darwin") {
        expect(osaCall).toBeDefined();
        expect(osaCall).toContain("on run argv");
        expect(osaCall).toContain("--");
      }
    });
  });
});

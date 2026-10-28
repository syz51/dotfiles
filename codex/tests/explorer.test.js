import { expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rolePath = fileURLToPath(new URL("../agents/explorer.toml", import.meta.url));

test("explorer role uses the configured model and reasoning effort", async () => {
  const role = Bun.TOML.parse(await readFile(rolePath, "utf8"));
  expect(role.name).toBe("explorer");
  expect(role.model).toBe("gpt-6.1-terra");
  expect(role.model_reasoning_effort).toBe("medium");
});

test("runtime explorer path resolves to the configured role file", async () => {
  expect(await realpath(join(homedir(), ".codex/agents/explorer.toml"))).toBe(
    await realpath(rolePath),
  );
});

test("reviewer configuration and parent review responsibilities remain intact", async () => {
  const reviewer = Bun.TOML.parse(await readFile(new URL("../agents/reviewer.toml", import.meta.url), "utf8"));
  expect(reviewer.name).toBe("reviewer");
  expect(reviewer.model).toBe("gpt-6.1-sol");
  expect(reviewer.model_reasoning_effort).toBe("xhigh");
  expect(reviewer.developer_instructions).toMatch(/Review only; do not edit files\./);
  const instructions = await readFile(new URL("../AGENTS.md", import.meta.url), "utf8");
  expect(instructions).toContain("Own planning, product and architecture design, review, and communication.");
  expect(instructions).toContain("Review results against the brief and diff, and run any missing checks.");
  expect(instructions).toContain("Use an independent reviewer for high-impact changes when practical.");
  expect(instructions).toContain("`reviewer` for independent review");
});

const archive = {
  "README.md": "# Synthetic research archive\nCurrent direction: decisions/current.md\nHistory: research-log.md\nTopic: topics/evidence.md\n",
  "research-log.md": "# History\n2026-09-01: Proposed Japanese answer generation.\n2026-10-12: Replaced that proposal; see decisions/current.md.\n",
  "decisions/current.md": "# Current decision\nAs of 2026-10-12, query language is English.\nThe deliverable is source-linked evidence retrieval.\nJapanese answer generation is deferred, not adopted.\n",
  "topics/evidence.md": "# Evidence topic\nEvidence coverage is the primary evaluation target.\nAnswer fluency is not an evaluation target.\n",
};
const cases = [
  {
    name: "multi-file codebase exploration",
    files: {
      "src/entry.js": 'import { buildSignal } from "./signal.js";\nexport function entry() {\n  return buildSignal(23);\n}\n',
      "src/signal.js": 'export function buildSignal(seed) {\n  return `cobalt-kestrel:${seed * 7 + 11}`;\n}\n',
    },
    prompt: "Determine the return value of entry(), following its helper call. Report the entry and helper function names, the exact computed value, and file:line citations for both the call and computation. Keep all investigation read-only and inside this fixture.",
    answer: ["cobalt-kestrel:172", "entry", "buildSignal", /src\/entry\.js:3\b/, /src\/signal\.js:2\b/],
  },
  {
    name: "document and paper inspection",
    files: {
      "papers/cedar.md": "# Cedar (synthetic paper)\nTask: retrieve a set of supporting passages.\nMethod: expand the query only when evidence is missing.\nMetric: evidence-set recall.\nLimitation: evaluated on 24 synthetic queries only.\n",
      "papers/larch.md": "# Larch (synthetic paper)\nTask: generate a fluent answer from supplied passages.\nMethod: rewrite the draft answer once.\nMetric: answer fluency.\nLimitation: retrieval quality was not evaluated.\n",
    },
    prompt: "Inspect both synthetic papers in papers/. Which paper evaluates evidence retrieval, and which evaluates answer generation? Compare their methods, metrics, and limitations with file:line citations. Do not infer results beyond the documents; keep this fixture unchanged.",
    answer: [/cedar/i, /larch/i, /evidence.set recall/i, /answer fluency/i, /24/, /not evaluated/i, /missing/i, /rewrite/i, /papers\/cedar\.md:[2-5]\b/, /papers\/larch\.md:[2-5]\b/],
  },
  {
    name: "archive search distinguishes history and current decisions",
    files: archive,
    prompt: "Search this synthetic research archive through its index, history, current decision, and topic notes. State the current query language, deliverable, and evaluation target. Explain whether Japanese answer generation was adopted or deferred and identify the superseded proposal. Cite file:line evidence for the current decision, historical proposal, and evaluation target. Keep every file unchanged.",
    answer: [/English/, /source.linked evidence retrieval/i, /evidence coverage/i, /deferred/i, /2026-09-01/, /decisions\/current\.md:[2-4]\b/, /research-log\.md:2\b/, /topics\/evidence\.md:2\b/],
  },
  {
    name: "public web research from official documentation",
    files: {},
    prompt: "Using the official Bun documentation, check whether Bun.TOML.parse parses TOML strings and whether Bun.file(path).json() parses JSON files. Explain the two input forms and cite the official page for each. This is a read-only source check; do not change local files.",
    answer: [/Bun\.TOML\.parse/, /Bun\.file/, /\.json\(\)/, /string/i, /file/i, /https:\/\/(?:www\.)?bun\.(?:com|sh)\/(?:docs|reference|guides)\/[^\s)]*toml/i, /https:\/\/(?:www\.)?bun\.(?:com|sh)\/(?:docs|reference|guides)\/[^\s)]*(?:json|file-io)/i],
    web: true,
  },
  {
    name: "authorized archive update from verified facts",
    files: {
      ...archive,
      "references.md": "# References\nREF-001: Synthetic project charter; retained historical reference.\n",
      "verified-facts.md": "# Verified synthetic facts\nOBS-028: On 2026-10-28 the coverage audit checked 18 queries; 15 have complete source-linked evidence and 3 need additional evidence.\nPROP-029: A reranking experiment is proposed, not adopted or evaluated.\nREF-002: Synthetic audit sheet, 2026-10-28, supports OBS-028.\nThe current research direction is unchanged.\n",
    },
    updates: {
      "topics/evidence.md": [/OBS-028/, /18/, /15/, /3/, /PROP-029/, /propos/i, /not(?:\s+(?:been|yet))?\s+adopted/i, /verified-facts\.md:[2-5]\b/, /decisions\/current\.md/],
      "research-log.md": [/2026-10-28/, /OBS-028/, /PROP-029/, /propos/i, /unchanged/i, /verified-facts\.md:[2-5]\b/],
      "references.md": [/REF-002/, /Synthetic audit sheet/i, /2026-10-28/, /OBS-028/, /verified-facts\.md:4\b/],
    },
    prompt: "Update this synthetic research archive using the explicitly supplied verified facts in verified-facts.md. Append a dated audit section to topics/evidence.md, append a research-log.md entry, and append REF-002 to references.md. Only these three paths are authorized for edits; preserve their existing text, reference IDs, and history exactly. In the topic section record OBS-028's 18 checked queries, 15 complete evidence sets, and 3 incomplete ones; distinguish observed results from PROP-029's proposed reranking experiment, which is not adopted or evaluated. In the log distinguish observation and proposal and state that the current direction is unchanged. In references record the supplied audit sheet, date, and supported observation ID. Include file:line citations to verified-facts.md in each addition, and connect the topic addition to decisions/current.md without changing that decision. Keep all other files unchanged. Report each updated path and summarize the recorded result.",
    answer: [/topics\/evidence\.md/, /research-log\.md/, /references\.md/, /OBS-028/, /PROP-029/],
  },
];

test("live task prompts leave role choice automatic", () => {
  for (const scenario of cases) {
    expect(scenario.prompt).not.toMatch(/delegat|subagent|explorer|worker|models?|reasoning effort/i);
  }
});

async function captureBounded(stream, label) {
  const reader = stream.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2 * 1024 * 1024) throw new Error(`${label} exceeded 2 MiB`);
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    reader.releaseLock();
  }
}

function assertMatches(value, matches) {
  expect(value).toBeString();
  for (const match of matches) {
    if (typeof match === "string") expect(value).toContain(match);
    else expect(value).toMatch(match);
  }
}

// Only sessions created after the baseline and owned by this unique fixture qualify.
async function fixtureSessions(sessions, before, fixture) {
  const owned = [];
  for await (const name of new Bun.Glob("**/*.jsonl").scan(sessions)) {
    if (before.has(name)) continue;
    const path = join(sessions, name);
    const source = await readFile(path, "utf8");
    if (JSON.parse(source.split("\n", 1)[0])?.payload?.cwd !== fixture) continue;
    owned.push({ name, records: source.trim().split("\n").map(JSON.parse) });
  }
  return owned;
}

async function runLive(scenario) {
  const scratch = await mkdtemp(join(process.env.TMPDIR || tmpdir(), "codex-explorer-test-"));
  const fixture = join(scratch, "fixture");
  const sessions = join(homedir(), ".codex/sessions");
  const before = new Set(await Array.fromAsync(new Bun.Glob("**/*.jsonl").scan(sessions)));
  const files = {
    "AGENTS.md": "Work only inside this synthetic fixture. Change only paths explicitly authorized by the task.\n",
    ...scenario.files,
  };
  let child;
  let timer;
  let fixturePath;
  try {
    for (const [name, content] of Object.entries(files)) {
      const path = join(fixture, name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
      await chmod(path, scenario.updates?.[name] ? 0o644 : 0o444);
    }
    fixturePath = await realpath(fixture);
    const baseline = (await readdir(fixture, { recursive: true })).sort();
    child = Bun.spawn([
      "codex", "exec", "--json", "--color", "never",
      "-c", `sqlite_home=${JSON.stringify(join(scratch, "state"))}`,
      "-c", `log_dir=${JSON.stringify(join(scratch, "logs"))}`,
      "--sandbox", scenario.updates ? "workspace-write" : "read-only",
      "--skip-git-repo-check", scenario.prompt,
    ], {
      cwd: fixture,
      env: { ...process.env, TMPDIR: scratch },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.race([
      Promise.all([captureBounded(child.stdout, "stdout"), captureBounded(child.stderr, "stderr"), child.exited]),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Codex live test timed out after 180s: ${scenario.name}`)), 180_000);
      }),
    ]);
    expect(exitCode, `codex failed; stderr: ${stderr.slice(-8000)}`).toBe(0);
    const events = stdout.split(/\r?\n/).filter(Boolean).map(JSON.parse);
    expect(events.some((event) => event.type === "turn.completed")).toBe(true);
    expect(events.filter((event) => event.type === "turn.failed" || event.type === "error")).toEqual([]);
    const transcripts = await fixtureSessions(sessions, before, fixturePath);
    const parentId = events.find((event) => event.type === "thread.started")?.thread_id;
    expect(parentId).toBeString();
    const role = scenario.updates ? "worker" : "explorer";
    const parent = transcripts.find(({ records }) => records[0]?.payload?.id === parentId);
    expect(parent?.records.some(({ type, payload }) =>
      type === "response_item" && payload.type === "function_call" && payload.name === "spawn_agent"
      && JSON.parse(payload.arguments).agent_type === role
    ), `Parent transcript must show a ${role} spawn`).toBe(true);
    const children = transcripts.filter(({ records }) => {
      const meta = records[0]?.payload;
      return meta?.agent_role === role && meta?.source?.subagent?.thread_spawn?.parent_thread_id === parentId;
    });
    expect(children.length, "Must find a child linked to this parent with the expected role").toBeGreaterThan(0);
    for (const { records } of children) {
      // Forks can contain inherited context; the final context resolves the child's turn.
      const context = records.findLast((record) => record.type === "turn_context")?.payload;
      expect(context?.model).toBe(scenario.updates ? "gpt-6.1-sol" : "gpt-6.1-terra");
      expect(context?.effort).toBe("medium");
    }
    if (scenario.web) {
      expect(children.some(({ records }) => records.some(({ type, payload }) =>
        type === "response_item" && (
          payload.type === "web_search_call"
          || (["function_call", "custom_tool_call"].includes(payload.type) && (
            /^(?:mcp__)?web[._]+(?:run|search|open)$/.test(payload.name)
            || (payload.name === "exec" && /tools\.web__run\s*\(/.test(payload.input ?? payload.arguments))
          ))
        )
      )), `Research child must actually call a web tool; observed calls: ${JSON.stringify(children.flatMap(({ records }) => records.filter(({ type }) => type === "response_item").map(({ payload }) => ({ type: payload.type, name: payload.name, namespace: payload.namespace })))).slice(-4000)}`).toBe(true);
    }
    const answer = events.filter((event) => event.type === "item.completed" && event.item.type === "agent_message").at(-1)?.item.text;
    assertMatches(answer, scenario.answer);
    expect((await readdir(fixture, { recursive: true })).sort()).toEqual(baseline);
    for (const [name, content] of Object.entries(files)) {
      const actual = await readFile(join(fixture, name), "utf8");
      if (scenario.updates?.[name]) {
        expect(actual.startsWith(content), `${name} must preserve its existing contents`).toBe(true);
        assertMatches(actual.slice(content.length), scenario.updates[name]);
      } else {
        expect(actual).toBe(content);
      }
    }
  } finally {
    clearTimeout(timer);
    try {
      if (child && child.exitCode === null) child.kill("SIGKILL");
      if (child) await child.exited;
    } finally {
      // --ephemeral cannot spawn children in Codex 0.165. Isolate state/logs and
      // remove only newly created transcripts whose metadata owns this fixture.
      try {
        if (fixturePath) {
          for (const { name } of await fixtureSessions(sessions, before, fixturePath)) {
            await rename(join(sessions, name), join(scratch, name.replaceAll("/", "_")));
          }
        }
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    }
  }
}

// Opt in with RUN_CODEX_EXPLORER_LIVE=1 bun test tests/explorer.test.js.
// Requires authenticated Codex and makes real calls. CLI JSON omits spawning;
// parent function calls plus child session metadata/context prove actual execution.
const liveTest = process.env.RUN_CODEX_EXPLORER_LIVE === "1" ? test : test.skip;
for (const scenario of cases) {
  liveTest(`live: ${scenario.name}`, () => runLive(scenario), 190_000);
}

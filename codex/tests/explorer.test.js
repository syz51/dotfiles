import { expect, test } from "bun:test";
import {
  injected,
  parseEvents,
  owned,
  ownedRoots,
  delegated,
  currentTurnCompleted,
  overlappingTurns,
  literalGuidanceRead,
  hash,
} from "./lib/evidence.js";
import { boundedProcess } from "./lib/process.js";
import { typedSnapshot, assertFixtureMetadata } from "./lib/filesystem.js";
import { reportDirectory } from "./lib/reports.js";
import { cleanupEntries } from "./lib/session-cleanup.js";
import { guidanceSnapshots, scoreGuidance } from "./lib/guidance-evidence.js";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rolePath = fileURLToPath(
  new URL("../agents/explorer.toml", import.meta.url),
);

test("explorer role uses the configured model and reasoning effort", async () => {
  const role = Bun.TOML.parse(await readFile(rolePath, "utf8"));
  expect(role.name).toBe("explorer");
  expect(role.model).toBe("gpt-6.1-terra");
  expect(role.model_reasoning_effort).toBe("medium");
});

test.skipIf(process.env.RUN_CODEX_RUNTIME_INTEGRATION !== "1")(
  "runtime explorer path resolves to the configured role file",
  async () => {
    expect(await realpath(join(homedir(), ".codex/agents/explorer.toml"))).toBe(
      await realpath(rolePath),
    );
  },
);

test("reviewer configuration and parent review responsibilities remain intact", async () => {
  const reviewer = Bun.TOML.parse(
    await readFile(new URL("../agents/reviewer.toml", import.meta.url), "utf8"),
  );
  expect(reviewer.name).toBe("reviewer");
  expect(reviewer.model).toBe("gpt-6.1-sol");
  expect(reviewer.model_reasoning_effort).toBe("xhigh");
  expect(reviewer.developer_instructions).toMatch(
    /Review only; do not edit files\./,
  );
});

const archive = {
  "README.md":
    "# Synthetic research archive\nCurrent direction: decisions/current.md\nHistory: research-log.md\nTopic: topics/evidence.md\n",
  "research-log.md":
    "# History\n2026-09-01: Proposed Japanese answer generation.\n2026-10-12: Replaced that proposal; see decisions/current.md.\n",
  "decisions/current.md":
    "# Current decision\nAs of 2026-10-12, query language is English.\nThe deliverable is source-linked evidence retrieval.\nJapanese answer generation is deferred, not adopted.\n",
  "topics/evidence.md":
    "# Evidence topic\nEvidence coverage is the primary evaluation target.\nAnswer fluency is not an evaluation target.\n",
};
const cases = [
  {
    name: "multi-file codebase exploration",
    files: {
      "src/entry.js":
        'import { buildSignal } from "./signal.js";\nexport function entry() {\n  return buildSignal(23);\n}\n',
      "src/signal.js":
        "export function buildSignal(seed) {\n  return `cobalt-kestrel:${seed * 7 + 11}`;\n}\n",
    },
    prompt:
      "Determine the return value of entry(), following its helper call. Report the entry and helper function names, the exact computed value, and file:line citations for both the call and computation. Keep all investigation read-only and inside this fixture.",
    answer: [
      "cobalt-kestrel:172",
      "entry",
      "buildSignal",
      /src\/entry\.js:3\b/,
      /src\/signal\.js:2\b/,
    ],
  },
  {
    name: "document and paper inspection",
    files: {
      "papers/cedar.md":
        "# Cedar (synthetic paper)\nTask: retrieve a set of supporting passages.\nMethod: expand the query only when evidence is missing.\nMetric: evidence-set recall.\nLimitation: evaluated on 24 synthetic queries only.\n",
      "papers/larch.md":
        "# Larch (synthetic paper)\nTask: generate a fluent answer from supplied passages.\nMethod: rewrite the draft answer once.\nMetric: answer fluency.\nLimitation: retrieval quality was not evaluated.\n",
    },
    prompt:
      "Inspect both synthetic papers in papers/. Which paper evaluates evidence retrieval, and which evaluates answer generation? Compare their methods, metrics, and limitations with file:line citations. Do not infer results beyond the documents; keep this fixture unchanged.",
    answer: [
      /cedar/i,
      /larch/i,
      /evidence.set recall/i,
      /answer fluency/i,
      /24/,
      /not evaluated/i,
      /missing/i,
      /rewrite/i,
      /papers\/cedar\.md:[2-5]\b/,
      /papers\/larch\.md:[2-5]\b/,
    ],
  },
  {
    name: "archive search distinguishes history and current decisions",
    files: archive,
    prompt:
      "Search this synthetic research archive through its index, history, current decision, and topic notes. State the current query language, deliverable, and evaluation target. Explain whether Japanese answer generation was adopted or deferred and identify the superseded proposal. Cite file:line evidence for the current decision, historical proposal, and evaluation target. Keep every file unchanged.",
    answer: [
      /English/,
      /source.linked evidence retrieval/i,
      /evidence coverage/i,
      /deferred/i,
      /2026-09-01|September\s+1(?:st)?\b/i,
      /decisions\/current\.md:[2-4]\b/,
      /research-log\.md:2\b/,
      /topics\/evidence\.md:2\b/,
    ],
  },
  {
    name: "public web research from official documentation",
    files: {},
    prompt:
      "Using the official Bun documentation, check whether Bun.TOML.parse parses TOML strings and whether Bun.file(path).json() parses JSON files. Explain the two input forms and cite the official page for each. This is a read-only source check; do not change local files.",
    answer: [
      /Bun\.TOML\.parse/,
      /Bun\.file/,
      /\.json\(\)/,
      /string/i,
      /file/i,
      /https:\/\/(?:www\.)?bun\.(?:com|sh)\/(?:docs|reference|guides)\/[^\s)]*toml/i,
      /https:\/\/(?:www\.)?bun\.(?:com|sh)\/(?:docs|reference|guides)\/[^\s)]*(?:json|file-io)/i,
    ],
    web: true,
  },
  {
    name: "authorized archive update from verified facts",
    files: {
      ...archive,
      "references.md":
        "# References\nREF-001: Synthetic project charter; retained historical reference.\n",
      "verified-facts.md":
        "# Verified synthetic facts\nOBS-028: On 2026-10-28 the coverage audit checked 18 queries; 15 have complete source-linked evidence and 3 need additional evidence.\nPROP-029: A reranking experiment is proposed, not adopted or evaluated.\nREF-002: Synthetic audit sheet, 2026-10-28, supports OBS-028.\nThe current research direction is unchanged.\n",
    },
    updates: {
      "topics/evidence.md": [
        /OBS-028/,
        /18/,
        /15/,
        /3/,
        /PROP-029/,
        /propos/i,
        /not(?:\s+(?:been|yet))?\s+adopted/i,
        /verified-facts\.md:[2-5]\b/,
        /decisions\/current\.md/,
      ],
      "research-log.md": [
        /2026-10-28/,
        /OBS-028/,
        /PROP-029/,
        /propos/i,
        /unchanged/i,
        /verified-facts\.md:[2-5]\b/,
      ],
      "references.md": [
        /REF-002/,
        /Synthetic audit sheet/i,
        /2026-10-28/,
        /OBS-028/,
        /verified-facts\.md:4\b/,
      ],
    },
    prompt:
      "Update this synthetic research archive using the explicitly supplied verified facts in verified-facts.md. Append a dated audit section to topics/evidence.md, append a research-log.md entry, and append REF-002 to references.md. Only these three paths are authorized for edits; preserve their existing text, reference IDs, and history exactly. In the topic section record OBS-028's 18 checked queries, 15 complete evidence sets, and 3 incomplete ones; distinguish observed results from PROP-029's proposed reranking experiment, which is not adopted or evaluated. In the log distinguish observation and proposal and state that the current direction is unchanged. In references record the supplied audit sheet, date, and supported observation ID. Include file:line citations to verified-facts.md in each addition, and connect the topic addition to decisions/current.md without changing that decision. Keep all other files unchanged. Report each updated path and summarize the recorded result.",
    answer: [
      /topics\/evidence\.md/,
      /research-log\.md/,
      /references\.md/,
      /OBS-028/,
      /PROP-029/,
    ],
  },
];

const contractCases = [
  {
    name: "hard debugging role contract",
    role: "solver",
    files: {
      "reserve.js":
        "export async function reserve(stock, n) { const count = await stock.read(); if (count < n) return false; await stock.write(count - n); return true; }\n",
      "invariant.md":
        "Initial stock is 1. Two concurrent calls each reserve 1 unit. Successful reservations must never exceed initial stock. A read and a write are individually atomic, but the whole function is not.\n",
    },
    prompt:
      "Use the configured hard-debugging role to analyze reserve.js against invariant.md. Give a minimal two-call interleaving, each return value and final stored count, and a correction that enforces the invariant. This is analysis only; keep files unchanged.",
    answer: [/both|two/i, /0/, /atomic|compare.and.swap|transaction|lock/i],
  },
  {
    name: "parallel independent module investigation",
    role: "explorer",
    parallel: true,
    files: {
      "a.js": "export function computeA(x) { return x * 7 + 11; }\n",
      "b.js": "export function computeB(x) { return x * x - 3; }\n",
    },
    prompt:
      "Investigate these independent modules in parallel: explain computeA(23) from a.js and computeB(9) from b.js. Trace each computation independently, cite file:line evidence, and summarize both exact results. Keep all files unchanged.",
    answer: ["172", "78", /a\.js:1/, /b\.js:1/],
  },
  {
    name: "independent reviewer contract",
    role: "reviewer",
    files: {
      "changes.diff":
        "--- a/access.js\n+++ b/access.js\n@@ -1 +1 @@\n-export const canRead = user => user.role === 'admin';\n+export const canRead = user => user.role !== 'admin';\n",
    },
    prompt:
      "Have an independent review of changes.diff for a blocking correctness defect. Explain the before/after behavior with a concrete admin and non-admin example. Review only; do not edit anything.",
    answer: [/admin/i, /non.admin|other|regular/i],
  },
  {
    name: "general fallback configuration probe",
    role: "default",
    fallback: true,
    files: {},
    prompt:
      "Use one general-purpose child with the configured general-task fallback to propose three imaginative names for a fictional moonlit bakery. This is creative ideation, not code, investigation, writing a deliverable, or a review; no configured specialty matches. Return the three names and a short reason for each, without editing files. For this controlled read-attribution probe, read any applicable guidance individually with literal single-file cat using its absolute path; avoid reader loops and combined inventory/read commands.",
    answer: [/\S/],
  },
];

test("live task prompts leave role choice automatic", () => {
  for (const scenario of cases) {
    expect(scenario.prompt).not.toMatch(
      /delegat|subagent|explorer|worker|models?|reasoning effort/i,
    );
  }
});

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
    try {
      const records = source.trim().split("\n").map(JSON.parse);
      if (
        records[0]?.type !== "session_meta" ||
        records[0]?.payload?.cwd !== fixture
      )
        continue;
      owned.push({ name, records });
    } catch {
      /* Uncertain or partial unrelated records must be retained. */
    }
  }
  return owned;
}

async function runLive(scenario) {
  const ordinaryGuidance = process.env.CODEX_EVAL_ORDINARY_GUIDANCE === "1";
  const scratch = await mkdtemp(
    join(process.env.TMPDIR || tmpdir(), "codex-explorer-test-"),
  );
  const fixture = join(scratch, "fixture");
  const sessions = join(homedir(), ".codex/sessions");
  const before = new Set(
    await Array.fromAsync(new Bun.Glob("**/*.jsonl").scan(sessions)),
  );
  const files = {
    "AGENTS.md":
      "Work only inside this synthetic fixture. Change only paths explicitly authorized by the task.\n",
    ...scenario.files,
  };
  let fixturePath, parentId, globalBefore, guideBefore, baseline, reportDir;
  let loadedInstructions = false;
  let sourceTranscripts = [],
    guidanceResult;
  let status = "failed",
    failure,
    rawTrace = "",
    commands = [],
    details = {};
  try {
    if (process.env.CODEX_EVAL_REPORT_DIR)
      reportDir = await reportDirectory(
        process.env.TMPDIR || tmpdir(),
        process.env.CODEX_EVAL_REPORT_DIR,
      );
    for (const [name, content] of Object.entries(files)) {
      const path = join(fixture, name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
      await chmod(path, scenario.updates?.[name] ? 0o644 : 0o444);
    }
    fixturePath = await realpath(fixture);
    baseline = await typedSnapshot(fixture);
    guideBefore = scenario.fallback
      ? await readFile(join(homedir(), ".config/codex/delegation.md"), "utf8")
      : null;
    globalBefore = await readFile(join(homedir(), ".codex/AGENTS.md"), "utf8");
    const {
      out: stdout,
      err: stderr,
      code: exitCode,
    } = await boundedProcess(
      [
        "codex",
        "exec",
        "--json",
        "--color",
        "never",
        "-c",
        `sqlite_home=${JSON.stringify(join(scratch, "state"))}`,
        "-c",
        `log_dir=${JSON.stringify(join(scratch, "logs"))}`,
        "--sandbox",
        scenario.updates ? "workspace-write" : "read-only",
        "--skip-git-repo-check",
        ordinaryGuidance && scenario.fallback
          ? scenario.prompt.split(
              " For this controlled read-attribution probe,",
            )[0]
          : scenario.prompt,
      ],
      {
        cwd: fixture,
        env: { ...process.env, TMPDIR: scratch },
        timeout: Number(process.env.CODEX_EVAL_TIMEOUT_MS || 180000),
      },
    );
    rawTrace = stdout;
    for (const line of stdout.split(/\r?\n/)) {
      try {
        const e = JSON.parse(line);
        if (e.type === "item.completed" && e.item?.type === "command_execution")
          commands.push(e.item);
      } catch {}
    }
    expect(
      await readFile(join(homedir(), ".codex/AGENTS.md"), "utf8"),
      "Instructions drifted",
    ).toBe(globalBefore);
    expect(exitCode, `codex failed; stderr: ${stderr.slice(-8000)}`).toBe(0);
    const events = parseEvents(stdout);
    expect(events.some((event) => event.type === "turn.completed")).toBe(true);
    expect(
      events.filter(
        (event) => event.type === "turn.failed" || event.type === "error",
      ),
    ).toEqual([]);
    const transcripts = await fixtureSessions(sessions, before, fixturePath);
    sourceTranscripts = transcripts;
    parentId = events.find(
      (event) => event.type === "thread.started",
    )?.thread_id;
    expect(parentId).toBeString();
    const role = scenario.role ?? (scenario.updates ? "worker" : "explorer");
    const expectedModel = role === "explorer" ? "gpt-6.1-terra" : "gpt-6.1-sol";
    const expectedEffort = ["reviewer", "solver"].includes(role)
      ? "xhigh"
      : role === "default"
        ? "high"
        : "medium";
    const parent = transcripts.find(
      ({ records }) => records[0]?.payload?.id === parentId,
    );
    const globalInstructions = globalBefore;
    expect(
      injected(parent?.records ?? [], globalInstructions),
      "Actual global instructions must appear in parent input",
    ).toBe(true);
    loadedInstructions = true;
    expect(
      currentTurnCompleted(parent.records),
      "Parent must complete its current source turn",
    ).toBe(true);
    expect(
      parent?.records.some(
        ({ type, payload }) =>
          type === "response_item" &&
          payload.type === "function_call" &&
          payload.name === "spawn_agent" &&
          JSON.parse(payload.arguments).agent_type === role,
      ),
      `Parent transcript must show a ${role} spawn`,
    ).toBe(true);
    const children = transcripts.filter(({ records }) => {
      const meta = records[0]?.payload;
      return (
        meta?.agent_role === role &&
        meta?.source?.subagent?.thread_spawn?.parent_thread_id === parentId
      );
    });
    expect(
      children.length,
      "Must find a child linked to this parent with the expected role",
    ).toBeGreaterThan(0);
    expect(
      delegated(
        parent.records,
        children.map((c) => c.records),
        role,
        expectedModel,
        expectedEffort,
        parentId,
      ),
      "Spawned configured child must actually complete",
    ).toBe(true);
    for (const { records } of children) {
      expect(
        currentTurnCompleted(records),
        "Every matched child must complete its current turn",
      ).toBe(true);
      // Forks can contain inherited context; the final context resolves the child's turn.
      const context = records.findLast(
        (record) => record.type === "turn_context",
      )?.payload;
      expect(context?.model).toBe(expectedModel);
      expect(context?.effort).toBe(expectedEffort);
    }
    if (scenario.parallel) {
      expect(children.length).toBeGreaterThanOrEqual(2);
      expect(
        overlappingTurns(children.map((c) => c.records)),
        "Completed child turn timestamps must overlap",
      ).toBe(true);
    }
    if (scenario.fallback) {
      expect(
        await readFile(join(homedir(), ".config/codex/delegation.md"), "utf8"),
      ).toBe(guideBefore);
      if (ordinaryGuidance) {
        const targets = await guidanceSnapshots([
          ["delegation", join(homedir(), ".config/codex/delegation.md")],
        ]);
        expect(targets.delegation.content).toBe(guideBefore);
        guidanceResult = await scoreGuidance(
          rawTrace,
          targets,
          ["delegation"],
          [],
          [],
          scratch,
          parent.records,
        );
        expect(
          guidanceResult.result.passed,
          JSON.stringify(guidanceResult.result.failures),
        ).toBe(true);
      } else {
        expect(
          literalGuidanceRead(
            events,
            join(homedir(), ".config/codex/delegation.md"),
            guideBefore,
          ),
          "Fallback guide needs an attributable complete literal read",
        ).toBe(true);
      }
    }
    if (scenario.web) {
      expect(
        children.some(({ records }) =>
          records.some(
            ({ type, payload }) =>
              type === "response_item" &&
              (payload.type === "web_search_call" ||
                (["function_call", "custom_tool_call"].includes(payload.type) &&
                  (/^(?:mcp__)?web[._]+(?:run|search|open)$/.test(
                    payload.name,
                  ) ||
                    (payload.name === "exec" &&
                      /tools\.web__run\s*\(/.test(
                        payload.input ?? payload.arguments,
                      ))))),
          ),
        ),
        `Research child must actually call a web tool; observed calls: ${JSON.stringify(children.flatMap(({ records }) => records.filter(({ type }) => type === "response_item").map(({ payload }) => ({ type: payload.type, name: payload.name, namespace: payload.namespace })))).slice(-4000)}`,
      ).toBe(true);
    }
    details = {
      role,
      model: expectedModel,
      effort: expectedEffort,
      childCount: children.length,
      currentChildTurns: children.map(({ records }) => ({
        contextTurnSha256: hash(
          records.findLast((r) => r.type === "turn_context").payload.turn_id,
        ),
        turnSha256: hash(
          records.findLast(
            (r) => r.type === "event_msg" && r.payload?.type === "task_started",
          ).payload.turn_id,
        ),
        completed: currentTurnCompleted(records),
      })),
      parallel: !!scenario.parallel,
      fallback: !!scenario.fallback,
      controlledReadFormat: !!scenario.fallback && !ordinaryGuidance,
      guidanceResult,
    };
    const answer = events
      .filter(
        (event) =>
          event.type === "item.completed" &&
          event.item.type === "agent_message",
      )
      .at(-1)?.item.text;
    assertMatches(answer, scenario.answer);
    assertFixtureMetadata(
      baseline,
      await typedSnapshot(fixture),
      Object.keys(scenario.updates ?? {}),
    );
    for (const [name, content] of Object.entries(files)) {
      const actual = await readFile(join(fixture, name), "utf8");
      if (scenario.updates?.[name]) {
        expect(
          actual.startsWith(content),
          `${name} must preserve its existing contents`,
        ).toBe(true);
        assertMatches(actual.slice(content.length), scenario.updates[name]);
      } else {
        expect(actual).toBe(content);
      }
    }
    status = "passed";
  } catch (error) {
    failure = String(error?.message ?? error);
    throw new Error(
      failure +
        "\nObserved completed commands: " +
        JSON.stringify(
          commands.map((i) => ({
            command: i.command,
            exit_code: i.exit_code,
            output: String(i.aggregated_output ?? "").slice(-4096),
          })),
        ).slice(-14000),
    );
  } finally {
    try {
      if (reportDir) {
        let current, after, inspectionError;
        try {
          current = await readFile(join(homedir(), ".codex/AGENTS.md"), "utf8");
          if (fixturePath) after = await typedSnapshot(fixturePath);
        } catch (error) {
          inspectionError = String(error);
        }
        const name = scenario.name.replaceAll(/[^a-z0-9]+/g, "-");
        await writeFile(join(reportDir, name + ".trace.jsonl"), rawTrace);
        for (const [index, transcript] of sourceTranscripts.entries())
          await writeFile(
            join(reportDir, name + `.source-${index}.jsonl`),
            transcript.records.map((r) => JSON.stringify(r)).join("\n") + "\n",
          );
        await writeFile(
          join(reportDir, name + ".json"),
          JSON.stringify(
            {
              case: scenario.name,
              status,
              passed: status === "passed",
              controlledReadFormat: !!scenario.fallback && !ordinaryGuidance,
              loadedInstructions,
              error: failure,
              globalSha256Before:
                globalBefore === undefined ? null : hash(globalBefore),
              globalSha256After: current === undefined ? null : hash(current),
              fixtureBefore: baseline,
              fixtureAfter: after,
              inspectionError,
              ...details,
              commands: commands.map((i) => ({
                command: i.command,
                exit_code: i.exit_code,
                output: String(i.aggregated_output ?? "").slice(-4096),
              })),
            },
            null,
            2,
          ) + "\n",
        );
      }
    } catch (reportError) {
      if (!failure) throw reportError;
      console.error("Diagnostics write failed:", String(reportError));
    } finally {
      // --ephemeral cannot spawn children in Codex 0.165. Isolate state/logs and
      // remove only newly created transcripts whose metadata owns this fixture.
      try {
        if (fixturePath) {
          const candidates = await cleanupEntries(
            sessions,
            before,
            fixturePath,
          );
          const roots = ownedRoots(candidates, fixturePath, parentId);
          for (const { name, records } of candidates) {
            if (![...roots].some((id) => owned(records, fixturePath, id)))
              continue;
            await rename(
              join(sessions, name),
              join(scratch, name.replaceAll("/", "_")),
            );
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

// Separate contract probes may explicitly request independent review, parallel work,
// or a general child; original automatic-role prompts remain unchanged.
const contractTest =
  process.env.RUN_CODEX_DELEGATION_CONTRACT_LIVE === "1" ? test : test.skip;
for (const scenario of contractCases)
  contractTest(
    `contract live: ${scenario.name}`,
    () => runLive(scenario),
    190000,
  );

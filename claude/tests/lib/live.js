// Harness for the opt-in live suites: real `claude -p` sessions against this machine's
// ~/.claude, each in a fixture folder under one temporary root per suite.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { removeSessionArtifacts } from "./cleanup.js";
import { conversation } from "./conversation.js";
import { assertUnchanged, snapshot } from "./filesystem.js";
import { childEnv, runProcess } from "./process.js";
import { Ledger, reportDirectory, writeReport } from "./reports.js";
import { bashRuns, completed, cost, initEvent, parseStream, resultEvent, skillLoads, toolUses } from "./stream.js";

export const LIVE = process.env.RUN_CLAUDE_LIVE === "1";
// Behavioral scenarios run on this model at the effort it gets in real use; checks of
// configuration loading, where model behavior does not matter, use HAIKU.
export const MODEL = process.env.CLAUDE_LIVE_MODEL || "claude-opus-5-5";
const SETTINGS = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "settings.json"), "utf8"));
// A model's modelSettings effort in this checkout's settings.json (the file ~/.claude
// links to), else high.
export function configuredEffort(model) {
  return SETTINGS.modelSettings?.[model]?.effortLevel ?? "high";
}
export const EFFORT = process.env.CLAUDE_LIVE_EFFORT || configuredEffort(MODEL);
export const HAIKU = "claude-haiku-5-5";
// Billed to the API while it has credit, else the subscription (claude/bin/claude-api).
const BIN = process.env.CLAUDE_LIVE_BIN || join(import.meta.dir, "..", "..", "bin", "claude-api");
const TIMEOUT = Number(process.env.CLAUDE_LIVE_TIMEOUT_MS) || 0;
const HOOKS = join(import.meta.dir, "hooks");

export const HOME_CLAUDE = join(homedir(), ".claude");
const PROJECTS = join(HOME_CLAUDE, "projects");
// Claude Code's own temporary folder when CLAUDE_CODE_TMPDIR is unset.
const CLAUDE_TMP = join(existsSync("/tmp") ? realpathSync("/tmp") : tmpdir(), `claude-${userInfo().uid}`);

// Configuration a session must not change. Installed skills are compared through their
// links, so a retargeted or edited skill fails the run.
function guardedPaths() {
  const paths = ["CLAUDE.md", "settings.json", "frontend-avoid.md", "agents", "hooks"].map((name) => join(HOME_CLAUDE, name));
  const skills = join(HOME_CLAUDE, "skills");
  if (existsSync(skills)) for (const name of readdirSync(skills)) paths.push(join(skills, name));
  paths.push(join(homedir(), ".codex", "skill-feedback"));
  return paths.filter((path) => existsSync(path));
}
const IGNORED = new Set(["node_modules", ".DS_Store"]);
const guardSnapshot = () => Object.fromEntries(guardedPaths().map((path) =>
  [path, snapshot(path, { allowLinks: true, followRoot: true, ignore: IGNORED })]));

function assertGuarded(before) {
  const after = guardSnapshot();
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const path of paths) {
    if (!before[path] || !after[path]) throw new Error(`Configuration changed during the run: ${path} appeared or vanished`);
    try {
      assertUnchanged(before[path], after[path]);
    } catch (error) {
      throw new Error(`Configuration changed during the run: ${path}: ${error.message}`);
    }
  }
}

const readRecords = (dir) => existsSync(dir)
  ? readdirSync(dir).sort().map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")))
  : [];

// The directory each tool call started in, by tool_use id, for a report. A hook killed
// mid-write when a session times out leaves a truncated record, which only that call's
// entry loses; a report must never replace the session's own error.
export function toolDirectories(dir) {
  const cwds = {};
  for (const name of existsSync(dir) ? readdirSync(dir) : []) {
    let record;
    try {
      record = JSON.parse(readFileSync(join(dir, name), "utf8"));
    } catch {
      continue;
    }
    if (record.hook_event_name === "PreToolUse") cwds[record.tool_use_id] = record.cwd;
  }
  return cwds;
}

const slug = (label) => label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);

function writeFiles(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

export function liveSuite(name) {
  const ledger = new Ledger(name);
  const outside = [];
  let root;
  let reports;
  let sequence = 0;

  // Runs one print-mode session; scratch files go in dir. Every PreToolUse and
  // InstructionsLoaded hook input is recorded; installs, downloads and web access are
  // blocked. Throws unless the session completed (or, with maxTurns, stopped at the
  // limit) and left the configuration as it found it. Cost and duration go to the ledger
  // even when it throws. With followUp, the prompt and the follow-up go in as a
  // conversation (see conversation.js), and the stream has one result per turn.
  async function session(dir, { label, cwd, prompt, followUp, model = MODEL, effort = EFFORT, maxTurns, timeout = 300_000, report }) {
    const id = `session-${String(++sequence).padStart(2, "0")}`;
    const recordDir = join(dir, `${id}-hooks`);
    mkdirSync(recordDir);
    const settings = join(dir, `${id}.settings.json`);
    const record = { type: "command", command: `"${process.execPath}" "${join(HOOKS, "record.js")}" "${recordDir}"` };
    const block = { type: "command", command: `"${process.execPath}" "${join(HOOKS, "block-installs.js")}"` };
    writeFileSync(settings, JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [record, block] }], InstructionsLoaded: [{ hooks: [record] }] },
    }));
    const args = ["-p", ...(followUp === undefined ? [prompt] : ["--input-format", "stream-json"]), "--model", model, "--effort", effort,
      "--no-session-persistence", "--output-format", "stream-json", "--verbose", "--settings", settings];
    if (maxTurns) args.push("--max-turns", String(maxTurns));
    const env = childEnv(process.env, {
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      CLAUDE_CODE_TMPDIR: root,
      TMPDIR: root,
      UV_OFFLINE: "1",
      UV_PYTHON_DOWNLOADS: "never",
      CARGO_NET_OFFLINE: "true",
      PYTHONDONTWRITEBYTECODE: "1",
    });
    const guard = guardSnapshot();
    const entry = { label, model, effort, durationMs: 0, status: "failed" };
    const started = Date.now();
    let stdout = "";
    let events = [];
    try {
      let run;
      try {
        run = await runProcess([BIN, ...args], {
          cwd, env, timeout: TIMEOUT || timeout, interact: followUp === undefined ? undefined : conversation(prompt, followUp),
        });
      } catch (error) {
        stdout = error.stdout ?? "";
        entry.status = /timeout/i.test(error.message) ? "timeout" : "error";
        throw error;
      }
      stdout = run.stdout;
      if (run.code !== 0 && !stdout.trim()) throw new Error(`claude exited ${run.code} with no output: ${run.stderr.slice(-2000)}`);
      events = parseStream(stdout);
      const init = initEvent(events);
      if (init && !init.cwd.startsWith(`${root}/`)) outside.push({ cwd: init.cwd, id: init.session_id });
      if (!completed(events, { allowMaxTurns: !!maxTurns }))
        throw new Error(`claude exited ${run.code} with result ${JSON.stringify(resultEvent(events)?.subtype)}: ${run.stderr.slice(-2000)}`);
      assertGuarded(guard);
      entry.status = "ok";
      const records = readRecords(recordDir);
      const preToolUse = records.filter((r) => r.hook_event_name === "PreToolUse");
      const cwds = new Map(preToolUse.map((r) => [r.tool_use_id, r.cwd]));
      return {
        model,
        effort,
        events,
        init,
        result: resultEvent(events),
        preToolUse,
        instructions: records.filter((r) => r.hook_event_name === "InstructionsLoaded"),
        // Bash calls with the directory the session reported for each.
        bash: bashRuns(events).map((run) => ({ ...run, cwd: cwds.get(run.id) })),
      };
    } finally {
      if (stdout) {
        try {
          entry.cost = cost(parseStream(stdout));
        } catch {
          // A truncated stream has no cost to recover; the run is already failing.
        }
      }
      entry.durationMs = Date.now() - started;
      ledger.record(entry);
      if (report) {
        report.sessions ??= [];
        // cwds holds what the stream lacks: each call's directory, from its PreToolUse hook,
        // kept even when the stream could not be parsed.
        report.sessions.push({
          ...entry, skills: skillLoads(events), tools: toolUses(events).map(({ id, name, parent, input }) => ({ id, name, parent, input })),
          cwds: toolDirectories(recordDir), stream: stdout,
        });
      }
    }
  }

  return {
    ledger,
    get root() {
      return root;
    },

    setup() {
      if (process.env.CLAUDE_LIVE_REPORT_DIR) reports = reportDirectory(tmpdir(), process.env.CLAUDE_LIVE_REPORT_DIR);
      root = realpathSync(mkdtempSync(join(tmpdir(), `claude-live-${name}-`)));
    },

    teardown() {
      try {
        if (root) removeSessionArtifacts({ bases: [PROJECTS, CLAUDE_TMP], roots: [root], sessions: outside });
      } finally {
        if (root) rmSync(root, { recursive: true, force: true });
        if (ledger.runs.length) console.log(ledger.summary());
      }
    },

    // A session whose scratch files stay in the suite root, for a cwd outside it.
    session: (options) => session(root, options),

    // Runs body(context) as one scenario in its own folder under the root. context has
    // report, fixture(files, name?) to create a folder of files, and session(options).
    // Writes the report when CLAUDE_LIVE_REPORT_DIR is set (a report failure never skips
    // cleanup), then removes the folder and the session folders derived from it.
    async scenario(label, body) {
      const dir = join(root, slug(label));
      mkdirSync(dir);
      const report = { scenario: label, status: "failed" };
      const context = {
        report,
        fixture(files = {}, folder = "fixture") {
          mkdirSync(join(dir, folder));
          writeFiles(join(dir, folder), files);
          return realpathSync(join(dir, folder));
        },
        session: (options) => session(dir, { label, report, ...options }),
      };
      try {
        await body(context);
        report.status = "passed";
      } catch (error) {
        report.error = String(error?.message ?? error);
        throw error;
      } finally {
        try {
          if (reports) {
            const streams = (report.sessions ?? []).map((entry) => entry.stream).join("");
            const summary = { ...report, sessions: report.sessions?.map(({ stream, ...rest }) => rest) };
            writeReport(reports, label, summary, streams);
          }
        } catch (error) {
          if (report.status === "passed") throw error;
          console.error(`Report write failed for ${label}: ${error.message}`);
        } finally {
          removeSessionArtifacts({ bases: [PROJECTS, CLAUDE_TMP], roots: [dir] });
          rmSync(dir, { recursive: true, force: true });
        }
      }
    },
  };
}

// Harness for the opt-in live suites: real `claude -p` sessions against this machine's
// ~/.claude, each in a fixture folder under one temporary root per suite.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { claudeTempDir, removeSessionArtifacts } from "./cleanup.js";
import { conversation } from "./conversation.js";
import { assertUnchanged, snapshot } from "./filesystem.js";
import { childEnv, runProcess, stopLeftovers } from "./process.js";
import { Ledger, reportDirectory, writeReport } from "./reports.js";
import { bashRuns, completed, cost, initEvent, parseStream, partialEvents, resultEvent, retryRefused, skillLoads, toolUses } from "./stream.js";

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
// How long teardown waits for the sessions' leftover processes, such as background tasks,
// to exit. TEARDOWN_TIMEOUT is the afterAll timeout that leaves room for it.
const SETTLE_MS = Number(process.env.CLAUDE_LIVE_SETTLE_MS) || 60_000;
export const TEARDOWN_TIMEOUT = SETTLE_MS + 30_000;
const HOOKS = join(import.meta.dir, "hooks");

export const HOME_CLAUDE = join(homedir(), ".claude");
const PROJECTS = join(HOME_CLAUDE, "projects");
// Sessions load the installed checkout's claude/ folder, which ~/.claude links to. Run
// from another checkout, such as a worktree, they do not load this checkout's
// configuration, so the checks of where it loads from are skipped. bun test loads this
// module once per run, so the notice prints once, before any session.
const CHECKOUT_CLAUDE = realpathSync(join(import.meta.dir, "..", ".."));
const INSTALLED_CLAUDE = existsSync(HOME_CLAUDE) ? realpathSync(HOME_CLAUDE) : HOME_CLAUDE;
export const AT_INSTALLED = INSTALLED_CLAUDE === CHECKOUT_CLAUDE;
if (LIVE && !AT_INSTALLED)
  console.log(`Live sessions use the installed checkout ${dirname(INSTALLED_CLAUDE)} (~/.claude is ${INSTALLED_CLAUDE}), `
    + `not this checkout ${dirname(CHECKOUT_CLAUDE)}. Configuration changes are live-tested only after merge and `
    + "config-sync; the checks of where sessions load configuration from are skipped.");

// config-sync (config-sync/config_sync.py) fast-forwards the installed checkout every 30
// minutes, which would change ~/.claude under a run and fail it. It skips its checks while
// a live process holds a lock in its locks folder, so each suite holds one, written whole,
// from setup to the end of teardown, pass or fail (bun test fires no exit event to hang
// this on). Suites in one process share one file, and each process has its own, so two
// runs at once do not release each other's. A run killed before teardown leaves a lock
// with a dead PID, which config-sync ignores.
export const CONFIG_SYNC_LOCKS = join(homedir(), ".local", "state", "config-sync", "locks");
export function holdConfigSync(dir = CONFIG_SYNC_LOCKS, pid = process.pid) {
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, `live-suite-${pid}.lock`);
  const temp = join(dir, `.live-suite-${pid}.tmp`);
  writeFileSync(temp, `${pid}\n`);
  renameSync(temp, lock);
  return () => rmSync(lock, { force: true });
}
let openSuites = 0;
let releaseConfigSync;

// Configuration a session must not change. Installed skills are compared through their
// links, so a retargeted or edited skill fails the run.
function guardedPaths() {
  const paths = ["CLAUDE.md", "settings.json", "frontend-avoid.md", "agents", "hooks"].map((name) => join(HOME_CLAUDE, name));
  const skills = join(HOME_CLAUDE, "skills");
  if (existsSync(skills)) for (const name of readdirSync(skills)) paths.push(join(skills, name));
  paths.push(skillFeedback());
  return paths.filter((path) => existsSync(path));
}
const SNAPSHOT = { allowLinks: true, followRoot: true, ignore: new Set(["node_modules", ".DS_Store"]) };

// The texts of the links from path to the first entry that is not a link.
function linkTexts(path) {
  const texts = [];
  for (let at = path; lstatSync(at).isSymbolicLink(); ) {
    texts.push(readlinkSync(at));
    at = resolve(dirname(at), texts.at(-1));
  }
  return texts;
}
// snapshot first: it throws on a link cycle, which linkTexts would follow forever.
const guardSnapshot = () => Object.fromEntries(guardedPaths().map((path) =>
  [path, { tree: snapshot(path, SNAPSHOT), links: linkTexts(path) }]));

// Each codex-skills release (one per merged PR) lands in its own folder under releases/
// and moves `current` to it. Skill links reach their skill through `current`, some by way
// of ~/.agents/skills, so a release resolves them to the same skill in another release.
// That passes when every link text is unchanged and the old release's copy is still as
// it was; a retargeted link or an edit to the old copy still fails.
const codexReleases = () => join(homedir(), ".local", "share", "codex-skills", "releases");
function releaseSwitched(before, after) {
  const releases = codexReleases();
  if (!existsSync(releases)) return false;
  const prefix = realpathSync(releases) + sep;
  const [from, to] = [before.tree["."].resolved, after.tree["."].resolved].map((path) =>
    path.startsWith(prefix) ? path.slice(prefix.length).split(sep) : []);
  if (from.length < 2 || to.length < 2 || from[0] === to[0] || from.slice(1).join(sep) !== to.slice(1).join(sep)) return false;
  if (JSON.stringify(before.links) !== JSON.stringify(after.links)) return false;
  assertUnchanged(before.tree, snapshot(before.tree["."].resolved, SNAPSHOT));
  return true;
}

// Skill feedback jobs in other sessions append records under <skill>/notes and
// <skill>/verifications while a run is going, so entries added there (and a new skill's
// folder) do not fail it. Edits and removals of existing entries still do.
const skillFeedback = () => join(homedir(), ".codex", "skill-feedback");
const appendedRecord = (key, entry) =>
  /^[^/]+\/(notes|verifications)(\/|$)/.test(key) || (entry.kind === "directory" && !key.includes("/"));
function withoutAppendedRecords(before, after) {
  const kept = Object.create(null);
  for (const key of Object.keys(after)) if (key in before || !appendedRecord(key, after[key])) kept[key] = after[key];
  return kept;
}

function assertGuarded(before) {
  const after = guardSnapshot();
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const path of paths) {
    if (!before[path] || !after[path]) throw new Error(`Configuration changed during the run: ${path} appeared or vanished`);
    try {
      if (releaseSwitched(before[path], after[path])) continue;
      const [was, now] = [before[path].tree, after[path].tree];
      assertUnchanged(was, path === skillFeedback() ? withoutAppendedRecords(was, now) : now);
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
  // Every process the sessions started (pid -> start time), for teardown.
  const tracked = new Map();
  let root;
  let reports;
  let sequence = 0;
  let holding = false;

  // Runs one print-mode session; scratch files go in dir. Every PreToolUse and
  // InstructionsLoaded hook input is recorded; installs, downloads and web access are
  // blocked. Throws unless the session completed (or, with maxTurns, stopped at the
  // limit) and left the configuration as it found it. Cost and duration go to the ledger
  // even when it throws. With followUp, the prompt and the follow-up go in as a
  // conversation (see conversation.js), and the stream has one result per turn. With
  // stopAtAnswer, the session ends when its first turn does, background tasks included.
  async function session(dir, { label, cwd, prompt, followUp, stopAtAnswer = false, model = MODEL, effort = EFFORT, maxTurns, timeout = 300_000, report }) {
    const id = `session-${String(++sequence).padStart(2, "0")}`;
    const recordDir = join(dir, `${id}-hooks`);
    mkdirSync(recordDir);
    const settings = join(dir, `${id}.settings.json`);
    const record = { type: "command", command: `"${process.execPath}" "${join(HOOKS, "record.js")}" "${recordDir}"` };
    const block = { type: "command", command: `"${process.execPath}" "${join(HOOKS, "block-installs.js")}"` };
    writeFileSync(settings, JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [record, block] }], InstructionsLoaded: [{ hooks: [record] }] },
    }));
    const streamed = followUp !== undefined || stopAtAnswer;
    const args = ["-p", ...(streamed ? ["--input-format", "stream-json"] : [prompt]), "--model", model, "--effort", effort,
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
    let refusedCost = 0;
    // The session's own folder of a run outside the suite root, for cleanup.
    const noteOutside = (init) => {
      if (init && !init.cwd.startsWith(`${root}/`)) outside.push({ cwd: init.cwd, id: init.session_id });
    };
    const noteRefused = (refused) => {
      if (!refused) return;
      noteOutside(initEvent(refused.events));
      refusedCost = cost(refused.events);
    };
    try {
      let run;
      try {
        // A run the API refused for credit or the key before it did anything runs once more,
        // on the subscription, recording only the run that counts.
        const attempt = async (limit, { subscription }) => {
          if (subscription) {
            rmSync(recordDir, { recursive: true });
            mkdirSync(recordDir);
          }
          const run = await runProcess([BIN, ...args], {
            cwd, env: subscription ? { ...env, API_FIRST_SUBSCRIPTION: "1" } : env, timeout: limit, track: tracked,
            interact: streamed ? conversation(prompt, followUp) : undefined,
          });
          return { run, events: partialEvents(run.stdout) };
        };
        const outcome = await retryRefused(attempt, TIMEOUT || timeout);
        run = outcome.run;
        noteRefused(outcome.refused);
      } catch (error) {
        noteRefused(error.refused);
        stdout = error.stdout ?? "";
        entry.status = /timeout/i.test(error.message) ? "timeout" : "error";
        throw error;
      }
      stdout = run.stdout;
      if (run.code !== 0 && !stdout.trim()) throw new Error(`claude exited ${run.code} with no output: ${run.stderr.slice(-2000)}`);
      events = parseStream(stdout);
      const init = initEvent(events);
      noteOutside(init);
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
          entry.cost = refusedCost + cost(parseStream(stdout));
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
      if (!holding) {
        if (openSuites++ === 0) releaseConfigSync = holdConfigSync();
        holding = true;
      }
      if (process.env.CLAUDE_LIVE_REPORT_DIR) reports = reportDirectory(tmpdir(), process.env.CLAUDE_LIVE_REPORT_DIR);
      root = realpathSync(mkdtempSync(join(tmpdir(), `claude-live-${name}-`)));
    },

    // Removes the root and the sessions' entries. A session's process can outlive it, such
    // as a background task, and write to the root (its TMPDIR) after the root is gone, so
    // the sessions' processes first get SETTLE_MS to exit. Those still running are then
    // killed and fail the suite, and so does a root that is still there.
    async teardown() {
      try {
        if (!root) return;
        let left;
        try {
          left = await stopLeftovers(root, { graceMs: SETTLE_MS, pollMs: 250, tracked });
          removeSessionArtifacts({ bases: [PROJECTS, claudeTempDir()], roots: [root], sessions: outside });
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
        if (left.length)
          throw new Error(`Session processes still ran ${SETTLE_MS} ms after the suite's sessions; killed them, then removed ${root}:\n`
            + left.map(({ pid, command }) => `${pid} ${command}`).join("\n"));
        if (existsSync(root)) throw new Error(`The suite root remains after teardown: ${root}`);
      } finally {
        if (holding) {
          holding = false;
          if (--openSuites === 0) releaseConfigSync();
        }
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
          removeSessionArtifacts({ bases: [PROJECTS, claudeTempDir()], roots: [dir] });
          rmSync(dir, { recursive: true, force: true });
        }
      }
    },
  };
}

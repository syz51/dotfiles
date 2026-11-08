// A stand-in for `claude -p --output-format stream-json` used by harness.test.js. It
// runs the hooks from --settings like Claude Code does, really executes the tool calls it
// reports, and behaves according to FAKE_MODE. It also writes a session entry under
// ~/.claude/projects despite --no-session-persistence, so cleanup is put to the test.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { projectName } from "./cleanup.js";

const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
const mode = process.env.FAKE_MODE;
const home = homedir();
const cwd = realpathSync(process.cwd());
const sessionId = crypto.randomUUID();
const projects = join(home, ".claude", "projects");

mkdirSync(join(projects, projectName(cwd)), { recursive: true });
writeFileSync(join(projects, projectName(cwd), `${sessionId}.jsonl`), `${JSON.stringify({ sessionId, cwd })}\n`);
mkdirSync(join(projects, "-unrelated-project"), { recursive: true });
writeFileSync(join(projects, "-unrelated-project", "other.jsonl"), "{}\n");

if (mode === "exit7") process.exit(7);
if (mode === "malformed") {
  console.log("{bad");
  process.exit(0);
}

const settings = JSON.parse(readFileSync(option("--settings"), "utf8"));
const events = [];
const emit = (event) => events.push(event);
let counter = 0;

// Runs the event's hooks; returns stderr of a hook that blocked (exit 2).
function runHooks(event, input) {
  for (const group of settings.hooks?.[event] ?? [])
    for (const hook of group.hooks) {
      const run = spawnSync("sh", ["-c", hook.command], { cwd, input: JSON.stringify({ session_id: sessionId, cwd, hook_event_name: event, ...input }), encoding: "utf8" });
      if (run.status === 2) return run.stderr;
    }
  return null;
}

// The Agent calls each subagent was spawned by, by tool_use id, for its hook records.
const agentTypes = new Map();

function tool(name, input, execute, parent = null) {
  const id = `toolu_fake_${++counter}`;
  emit({ type: "assistant", parent_tool_use_id: parent, message: { id: `msg_${counter}`, model: option("--model"), content: [{ type: "tool_use", id, name, input }] } });
  const blocked = runHooks("PreToolUse", { tool_name: name, tool_input: input, tool_use_id: id, effort: { level: option("--effort") }, ...(parent ? { agent_type: agentTypes.get(parent) } : {}) });
  const { text, isError = false, meta } = blocked ? { text: blocked, isError: true } : execute();
  if (name === "Agent") agentTypes.set(id, input.subagent_type ?? "general-purpose");
  emit({ type: "user", parent_tool_use_id: parent, tool_use_result: meta, message: { content: [{ type: "tool_result", tool_use_id: id, content: text, ...(isError ? { is_error: true } : {}) }] } });
  return id;
}

const readFile = (path, parent) => tool("Read", { file_path: path }, () => {
  const content = readFileSync(path, "utf8");
  const lines = content.split("\n").length;
  return { text: content, meta: { type: "text", file: { filePath: path, content, startLine: 1, numLines: lines, totalLines: lines } } };
}, parent);

const bash = (command) => tool("Bash", { command }, () => {
  const run = spawnSync("sh", ["-c", command], { cwd, encoding: "utf8" });
  const output = run.stdout + run.stderr;
  return run.status === 0 ? { text: output } : { text: `Exit code ${run.status}\n${output}`, isError: true };
});

const skill = (name) => tool("Skill", { skill: name }, () => ({ text: `Launching skill: ${name}` }));

emit({ type: "system", subtype: "init", cwd, session_id: sessionId, model: option("--model"), agents: ["explorer"], skills: [] });
runHooks("InstructionsLoaded", { file_path: join(home, ".claude", "CLAUDE.md"), memory_type: "User" });
// With FAKE_REFUSE_ONCE (a marker path), the first run ends as Claude Code ends one the API
// refuses for credit.
if (process.env.FAKE_REFUSE_ONCE && !existsSync(process.env.FAKE_REFUSE_ONCE)) {
  writeFileSync(process.env.FAKE_REFUSE_ONCE, "");
  runHooks("StopFailure", { error: "billing_error", last_assistant_message: "Credit balance is too low" });
  emit({ type: "result", subtype: "success", is_error: true, api_error_status: 400, result: "Credit balance is too low", total_cost_usd: 0, num_turns: 1 });
  for (const event of events) console.log(JSON.stringify(event));
  process.exit(1);
}
if (mode === "incomplete") {
  console.log(JSON.stringify(events[0]));
  process.exit(0);
}
if (mode === "timeout") await Bun.sleep(60_000);

let answer = "Done.";
if (mode.startsWith("python-")) {
  // python-mutation: the fixed module appends a receipt to itself on first import and
  // edits the protected check on the second, which the harness's own re-run triggers.
  const mutation = 'from pathlib import Path\n_self = Path(__file__)\nif "# rec" + "eipt" not in _self.read_text():\n    _self.write_text(_self.read_text() + "# receipt\\n")\nelse:\n    Path("check.py").write_text(Path("check.py").read_text() + "# tampered\\n")\n';
  writeFileSync(join(cwd, "calc.py"), `${mode === "python-mutation" ? mutation : ""}def total(values):\n    return sum(values)\n`);
  // python-delegated: the fix is right, but the session hands the small task to a worker.
  if (mode === "python-delegated") tool("Agent", { subagent_type: "worker", prompt: "Fix calc.py." }, () => ({ text: "Fixed." }));
  bash("uv run --no-project --offline python -B check.py");
  answer = "Fixed calc.py; uv run check.py printed fixture-check:ok.";
}
if (mode.startsWith("chart-")) {
  skill("frontend-ui");
  skill("dataviz");
  readFile(join(cwd, "brief.md"));
  readFile(join(home, ".claude", "frontend-avoid.md"));
  const spawn = tool("Agent", { subagent_type: "explorer", prompt: "Check the brief." }, () => ({ text: "Checked." }));
  if (mode === "chart-forbidden") readFile(join(home, ".claude", "skills", "typescript", "SKILL.md"), spawn);
  answer = "Use an accessible bar chart in a quiet visual direction.";
}
if (mode.startsWith("chinese-")) {
  if (mode === "chinese-drift") appendFileSync(join(home, ".claude", "CLAUDE.md"), "- Changed during the run.\n");
  if (mode === "chinese-retarget") {
    const link = join(home, ".claude", "skills", "typescript");
    rmSync(link);
    symlinkSync(join(home, "releases", "typescript-b"), link);
  }
  if (mode === "chinese-skill-edit") appendFileSync(join(home, "releases", "typescript", "SKILL.md"), "edited\n");
  // A codex-skills release moves `current` from release-a to release-b; an edit to the old
  // release, or a link retargeted straight at the new release, must still fail.
  const codex = join(home, ".local", "share", "codex-skills");
  if (["chinese-release-switch", "chinese-release-old-edit"].includes(mode)) {
    rmSync(join(codex, "current"));
    symlinkSync(join(codex, "releases", "release-b"), join(codex, "current"));
  }
  if (mode === "chinese-release-old-edit") appendFileSync(join(codex, "releases", "release-a", "skills", "rust", "SKILL.md"), "edited\n");
  if (mode === "chinese-agents-retarget") {
    const link = join(home, ".agents", "skills", "find-skills");
    rmSync(link);
    symlinkSync(join(codex, "releases", "release-b", "skills", "find-skills"), link);
  }
  // Skill feedback written meanwhile: records appended by other sessions' jobs, an
  // existing record edited or removed, and a file added outside notes/ and verifications/.
  const feedback = join(home, ".codex", "skill-feedback");
  const write = (path, content) => {
    mkdirSync(join(feedback, path, ".."), { recursive: true });
    writeFileSync(join(feedback, path), content);
  };
  if (mode === "chinese-feedback-append") {
    write("rust/verifications/new.json", "{}\n");
    write("rust/notes/new.md", "# New note\n");
    write("tauri/verifications/first.json", "{}\n");
  }
  if (mode === "chinese-feedback-edit") appendFileSync(join(feedback, "rust", "notes", "old.md"), "edited\n");
  if (mode === "chinese-feedback-remove") rmSync(join(feedback, "rust", "verifications", "old.json"));
  if (mode === "chinese-feedback-other") write("rust/README.md", "# Rust\n");
  answer = "我会参加明天的会议。";
}
if (mode.startsWith("review-")) {
  // A conversation over stream-json input: each turn's events go out when the turn ends,
  // and the session exits once stdin ends. review-background hands the review to a
  // background agent and answers the follow-up while it runs; review-late does the same
  // but answers only after the review; review-foreground runs the review itself;
  // review-unrecorded never records the outcomes through ReportFindings, review-early
  // records them before the review ends, review-dismissed records the real finding as
  // no change needed, and review-uncategorized leaves out its category. As in
  // Claude Code, agents run in the background without a flag, and stdin ending while the
  // review still runs stops it.
  const lines = (async function* () {
    let pending = "";
    for await (const chunk of process.stdin) {
      pending += chunk;
      for (let i; (i = pending.indexOf("\n")) >= 0; pending = pending.slice(i + 1)) yield pending.slice(0, i);
    }
  })();
  const nextMessage = async () => {
    const { value, done } = await lines.next();
    return done ? null : JSON.parse(value).message.content;
  };
  const turn = (text) => {
    emit({ type: "result", subtype: "success", is_error: false, result: text, total_cost_usd: 0.001, num_turns: counter + 1 });
    for (const event of events.splice(0)) console.log(JSON.stringify(event));
  };
  const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).stdout.trim();
  const findings = "canEdit now lets anyone who is not the owner edit: `!==` should be `===`.";
  // The outcomes, once decided: read-only, so the real finding is skipped.
  const record = () => {
    if (mode === "review-unrecorded") return;
    const finding = { file: "auth/access.js", line: 3, summary: "canEdit lets anyone who is not the owner edit", failure_scenario: "a non-owner edits a document",
      ...(mode === "review-uncategorized" ? {} : { category: "correctness" }), outcome: mode === "review-dismissed" ? "no_change_needed" : "skipped" };
    tool("ReportFindings", { findings: [finding] }, () => ({ text: "Reported." }));
  };
  await nextMessage();
  if (mode === "review-foreground") {
    tool("Skill", { skill: "code-review", args: `xhigh origin/main...${sha}` }, () => ({ text: findings }));
    turn(findings);
    await nextMessage();
    turn("391");
  } else {
    const spawn = tool("Agent", { subagent_type: "general-purpose", isolation: "worktree", prompt: "Review it." },
      () => ({ text: "Async agent launched successfully." }));
    emit({ type: "system", subtype: "task_started", task_id: "task_review", tool_use_id: spawn, is_backgrounded: true });
    emit({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "task_review" }] });
    tool("Skill", { skill: "code-review", args: `xhigh origin/main...${sha}` }, () => ({ text: findings }), spawn);
    const finish = (status = "completed") => {
      emit({ type: "system", subtype: "task_notification", task_id: "task_review", tool_use_id: spawn, status });
      emit({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    };
    turn("The review is running in the background.");
    if (await nextMessage() === null) {
      finish("stopped");
      turn("Stopped.");
      process.exit(0);
    }
    if (mode === "review-late") finish();
    turn("391");
    if (mode !== "review-late") {
      // The review takes a moment; stdin closing meanwhile stops it.
      const closed = await Promise.race([nextMessage().then((message) => message === null), Bun.sleep(300).then(() => false)]);
      if (!closed && mode === "review-early") record();
      finish(closed ? "stopped" : "completed");
      if (!closed && mode !== "review-early") record();
      turn(closed ? "The review was stopped." : findings);
      if (closed) process.exit(0);
    } else {
      record();
      turn(findings);
    }
  }
  while (await nextMessage() !== null);
  process.exit(0);
}
if (mode === "article-claim") {
  skill("content-research-writer");
  answer = "I drafted the article and saved it as article.md.";
}

emit({ type: "result", subtype: "success", is_error: false, result: answer, total_cost_usd: 0.001, num_turns: counter + 1 });
for (const event of events) console.log(JSON.stringify(event));

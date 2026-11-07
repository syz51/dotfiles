// Child processes with a deadline, a shared output bound and an isolated environment.
import { spawn, spawnSync } from "node:child_process";

// Variables a running Claude Code session, or the app hosting it, puts in its tools'
// environment. A test's child `claude` must start as a fresh session, not inherit them.
const SESSION_VARIABLE = /^(?:CLAUDECODE|CLAUDE_\w*|AI_AGENT|T3CODE_\w*)$/;

// Test and benchmark sessions stay off the shared work board: claude/hooks/board-hook.sh
// skips the board with AGENT_BOARD_HOOKS=off. An override can turn it back on.
export function childEnv(base, overrides = {}) {
  const env = Object.fromEntries(Object.entries(base).filter(([name]) => !SESSION_VARIABLE.test(name)));
  return { ...env, AGENT_BOARD_HOOKS: "off", ...overrides };
}

// Process ids descending from pid, from one snapshot of the process table. A child that
// started its own process group (as nested runProcess calls do) is outside pid's group,
// so killing the group alone would leave it running.
function descendants(pid) {
  const table = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
  if (table.status !== 0) return [];
  const children = new Map();
  for (const line of table.stdout.split("\n")) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (child && parent) children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  const found = [];
  for (let queue = [pid]; queue.length;) for (const child of children.get(queue.shift()) ?? []) {
    found.push(child);
    queue.push(child);
  }
  return found;
}

// Processes, other than this one, working inside dir or naming it in their command line:
// what a session left running in a fixture. dir must be a real path, as lsof reports
// working directories resolved. Returns [{ pid, command }].
export function processesUnder(dir) {
  const inside = (path) => path === dir || path.startsWith(`${dir}/`);
  const pids = new Set();
  // lsof exits 1 when it could not inspect some processes; its output still counts.
  const cwds = spawnSync("lsof", ["-nP", "-d", "cwd", "-Fpn"], { encoding: "utf8" });
  if (cwds.error) throw cwds.error;
  let pid;
  for (const line of cwds.stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && inside(line.slice(1))) pids.add(pid);
  }
  const table = spawnSync("ps", ["-A", "-ww", "-o", "pid=,command="], { encoding: "utf8" });
  if (table.status !== 0) throw new Error(`ps failed: ${table.stderr}`);
  const commands = new Map();
  for (const line of table.stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s(.*)$/);
    if (!match) continue;
    commands.set(Number(match[1]), match[2]);
    if (match[2].includes(dir)) pids.add(Number(match[1]));
  }
  pids.delete(process.pid);
  // A process that exited between the two snapshots has no command: it is gone.
  return [...pids].filter((id) => commands.has(id)).map((id) => ({ pid: id, command: commands.get(id) }));
}

// Processes still under dir once graceMs has passed (see processesUnder), each then
// killed: what a session left behind, given its own children time to finish exiting.
// Returns them as found. A process gone by the time it is signalled is skipped.
export async function stopLeftovers(dir, { graceMs = 3000, pollMs = 100 } = {}) {
  let left = processesUnder(dir);
  for (const deadline = Date.now() + graceMs; left.length && Date.now() < deadline; left = processesUnder(dir))
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  for (const { pid } of left)
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  return left;
}

// Runs argv in its own process group. Resolves with the exit status and UTF-8 output;
// rejects on a spawn error, on the deadline or when stdout and stderr together exceed
// maxBytes, killing every descendant and the whole group, so processes in nested groups
// and those that outlive the leader die too.
// A rejection carries the output captured so far as error.stdout and error.stderr.
// input, when given, is written to stdin, which is then closed; otherwise stdin is empty.
// interact, instead, holds stdin open for a conversation: it is called once with stdin and
// returns a listener that gets stdout as text, chunk by chunk; it must end stdin itself.
export function runProcess(argv, { cwd, env, timeout = 180_000, maxBytes = 32 * 1024 * 1024, input, interact } = {}) {
  if (input !== undefined && interact) throw new Error("runProcess takes input or interact, not both");
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const piped = input !== undefined || !!interact;
    const child = spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: [piped ? "pipe" : "ignore", "pipe", "pipe"] });
    const out = [];
    const err = [];
    let size = 0;
    let failure;
    // A child that exits without reading its input makes the write fail with EPIPE,
    // which is harmless; any other write error fails the run.
    if (piped)
      child.stdin.on("error", (error) => {
        if (error.code !== "EPIPE") failure ??= error;
      });
    if (input !== undefined) child.stdin.end(input);
    // Kills once: later chunks past the bound must not rescan the process table. A
    // descendant that is gone (ESRCH) or not ours to signal (EPERM, such as a pid reused by
    // another user since the snapshot) is skipped, so the group kill below always runs.
    let killed = false;
    const kill = () => {
      if (killed) return;
      killed = true;
      for (const pid of descendants(child.pid))
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH" && error.code !== "EPERM") throw error;
        }
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      failure ??= new Error(`Process timeout after ${timeout} ms: ${argv[0]}`);
      kill();
    }, timeout);
    // A listener, or an interact call, that throws fails the run like any other failure;
    // once the run has failed, the listener gets no more output.
    let listen;
    try {
      listen = interact?.(child.stdin);
    } catch (error) {
      failure ??= error;
      kill();
    }
    // Keeps a character split across chunks whole in the listener's text.
    const decoder = new TextDecoder();
    for (const [stream, chunks] of [[child.stdout, out], [child.stderr, err]])
      stream.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          failure ??= new Error(`Output bound of ${maxBytes} bytes exceeded: ${argv[0]}`);
          kill();
        } else {
          chunks.push(Buffer.from(chunk));
          if (listen && !failure && stream === child.stdout)
            try {
              listen(decoder.decode(chunk, { stream: true }));
            } catch (error) {
              failure ??= error;
              kill();
            }
        }
      });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8");
      if (failure) reject(Object.assign(failure, { stdout, stderr }));
      else resolve({ code, signal, stdout, stderr, durationMs: Date.now() - started });
    });
  });
}

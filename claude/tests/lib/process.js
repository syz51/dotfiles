// Child processes with a deadline, a shared output bound and an isolated environment.
import { spawn, spawnSync } from "node:child_process";

// Variables a running Claude Code session, or the app hosting it, puts in its tools'
// environment. A test's child `claude` must start as a fresh session, not inherit them.
const SESSION_VARIABLE = /^(?:CLAUDECODE|CLAUDE_\w*|AI_AGENT|T3CODE_\w*)$/;

export function childEnv(base, overrides = {}) {
  const env = Object.fromEntries(Object.entries(base).filter(([name]) => !SESSION_VARIABLE.test(name)));
  return { ...env, ...overrides };
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

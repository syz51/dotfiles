// Child processes with a deadline, a shared output bound and an isolated environment.
import { spawn } from "node:child_process";

// Variables a running Claude Code session, or the app hosting it, puts in its tools'
// environment. A test's child `claude` must start as a fresh session, not inherit them.
const SESSION_VARIABLE = /^(?:CLAUDECODE|CLAUDE_\w*|AI_AGENT|T3CODE_\w*)$/;

export function childEnv(base, overrides = {}) {
  const env = Object.fromEntries(Object.entries(base).filter(([name]) => !SESSION_VARIABLE.test(name)));
  return { ...env, ...overrides };
}

// Runs argv in its own process group. Resolves with the exit status and UTF-8 output;
// rejects on a spawn error, on the deadline or when stdout and stderr together exceed
// maxBytes, killing the whole group, so descendants that outlive the leader die too.
// A rejection carries the output captured so far as error.stdout and error.stderr.
// input, when given, is written to stdin, which is then closed; otherwise stdin is empty.
export function runProcess(argv, { cwd, env, timeout = 180_000, maxBytes = 32 * 1024 * 1024, input } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    if (input !== undefined) {
      // A child that exits without reading its input makes the write fail with EPIPE.
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
    const out = [];
    const err = [];
    let size = 0;
    let failure;
    const kill = () => {
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
    for (const [stream, chunks] of [[child.stdout, out], [child.stderr, err]])
      stream.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          failure ??= new Error(`Output bound of ${maxBytes} bytes exceeded: ${argv[0]}`);
          kill();
        } else chunks.push(Buffer.from(chunk));
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

// Child processes with a deadline, a shared output bound and an isolated environment.
import { spawn, spawnSync } from "node:child_process";
import { SESSION_VARIABLE } from "../../bin/session-env.js";

// A test's child `claude` must start as a fresh session, not inherit the parent session's
// variables (SESSION_VARIABLE).

// Test and benchmark sessions stay off the shared work board: claude/hooks/board-hook.sh
// skips the board with AGENT_BOARD_HOOKS=off. An override can turn it back on.
export function childEnv(base, overrides = {}) {
  const env = Object.fromEntries(Object.entries(base).filter(([name]) => !SESSION_VARIABLE.test(name)));
  return { ...env, AGENT_BOARD_HOOKS: "off", ...overrides };
}

// Process ids descending from pid, from one snapshot of the process table. A child that
// started its own process group (as nested runProcess calls do) is outside pid's group,
// so killing the group alone would leave it running.
// A failed snapshot finds none.
export function descendants(pid) {
  let table;
  try {
    table = processTable();
  } catch {
    return [];
  }
  return below(table, [pid]);
}

// One snapshot of the process table: pid -> { ppid, pgid, zombie, started, command }.
// started (the start time) tells a process from a later one that reuses its pid. A zombie
// has exited and waits only for its parent to collect its status.
function processTable() {
  const table = spawnSync("ps", ["-A", "-ww", "-o", "pid=,ppid=,pgid=,stat=,lstart=,command="], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
  if (table.status !== 0) throw new Error(`ps failed: ${table.stderr}`);
  const processes = new Map();
  for (const line of table.stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/);
    if (match)
      processes.set(Number(match[1]), { ppid: Number(match[2]), pgid: Number(match[3]), zombie: match[4].startsWith("Z"), started: match[5], command: match[6] });
  }
  return processes;
}

// Every process in table descending from one of pids.
function below(table, pids) {
  const children = new Map();
  for (const [child, { ppid }] of table) children.set(ppid, [...(children.get(ppid) ?? []), child]);
  const found = [];
  for (let queue = [...pids]; queue.length;) for (const child of children.get(queue.shift()) ?? []) {
    found.push(child);
    queue.push(child);
  }
  return found;
}

// Adds to tracked (pid -> start time) every process descending from pid now. Polled while
// pid runs, it keeps the processes a session started, such as background tasks, findable
// after the session exits, when they no longer descend from it.
export function trackDescendants(pid, tracked) {
  const table = processTable();
  for (const child of below(table, [pid])) tracked.set(child, table.get(child).started);
}

// Processes, other than this one, working inside dir or naming it in their command line,
// plus those in tracked (see trackDescendants) still running and their descendants: what
// a session left running in a fixture. dir must be a real path, as lsof reports working
// directories resolved. Returns [{ pid, pgid, command }], without zombies, which have
// already exited.
export function processesUnder(dir, { tracked = new Map() } = {}) {
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
  const table = processTable();
  for (const [id, { command }] of table) if (command.includes(dir)) pids.add(id);
  const live = [...tracked].filter(([id, started]) => table.get(id)?.started === started).map(([id]) => id);
  for (const id of [...live, ...below(table, live)]) pids.add(id);
  pids.delete(process.pid);
  // A process that exited between the two snapshots is not in the table: it is gone.
  return [...pids].filter((id) => table.has(id) && !table.get(id).zombie)
    .map((id) => ({ pid: id, pgid: table.get(id).pgid, command: table.get(id).command }));
}

// Processes still under dir once graceMs has passed (see processesUnder, which also gets
// tracked), then killed: what a session left behind, given its own children time to
// finish exiting. Returns each process found, once, in the order found.
// A leftover can fork after the snapshot, such as a loop starting its next write, and its
// child would then outlive the kill. So each leftover's whole process group dies with it,
// except this process's own group, and the scan repeats until it finds none; a process
// still found after killMs of rounds throws. A process gone by the time it is signalled is
// skipped, and so is a group with a member not ours to signal.
export async function stopLeftovers(dir, { graceMs = 3000, pollMs = 100, killMs = 5000, tracked } = {}) {
  const pause = () => new Promise((resolve) => setTimeout(resolve, pollMs));
  let left = processesUnder(dir, { tracked });
  for (const deadline = Date.now() + graceMs; left.length && Date.now() < deadline; left = processesUnder(dir, { tracked }))
    await pause();
  const found = new Map();
  const ownGroup = processTable().get(process.pid).pgid;
  for (const deadline = Date.now() + killMs; left.length; left = processesUnder(dir, { tracked })) {
    if (Date.now() >= deadline)
      throw new Error(`Processes under ${dir} still ran ${killMs} ms after being killed:\n${left.map(({ pid, command }) => `${pid} ${command}`).join("\n")}`);
    for (const leftover of left) {
      if (!found.has(leftover.pid)) found.set(leftover.pid, leftover);
      if (leftover.pgid > 1 && leftover.pgid !== ownGroup)
        try {
          process.kill(-leftover.pgid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH" && error.code !== "EPERM") throw error;
        }
      try {
        process.kill(leftover.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    await pause();
  }
  return [...found.values()];
}

// Runs argv in its own process group. Resolves with the exit status and UTF-8 output;
// rejects on a spawn error, on the deadline or when stdout and stderr together exceed
// maxBytes, killing every descendant and the whole group, so processes in nested groups
// and those that outlive the leader die too.
// A rejection carries the output captured so far as error.stdout and error.stderr.
// input, when given, is written to stdin, which is then closed; otherwise stdin is empty.
// interact, instead, holds stdin open for a conversation: it is called once with stdin and
// returns a listener that gets stdout as text, chunk by chunk; it must end stdin itself.
// track, a Map, gets the child's descendants every trackMs while it runs (see
// trackDescendants), so those that outlive it can be waited for.
export function runProcess(argv, { cwd, env, timeout = 180_000, maxBytes = 32 * 1024 * 1024, input, interact, track, trackMs = 250 } = {}) {
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
    const poll = () => {
      try {
        trackDescendants(child.pid, track);
      } catch (error) {
        failure ??= error;
        kill();
      }
    };
    const tracker = track && child.pid && setInterval(poll, trackMs);
    if (tracker) poll();
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
      clearInterval(tracker);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      clearInterval(tracker);
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8");
      if (failure) reject(Object.assign(failure, { stdout, stderr }));
      else resolve({ code, signal, stdout, stderr, durationMs: Date.now() - started });
    });
  });
}

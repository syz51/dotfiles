import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv, processesUnder, runProcess, stopLeftovers } from "./process.js";

const bun = process.execPath;
const SPAWN_TIMEOUT = 20_000;
const SCAN_TIMEOUT = 30_000;

test("childEnv drops parent-session variables and keeps the rest", () => {
  const env = childEnv({
    PATH: "/bin", HOME: "/home/a", ANTHROPIC_API_KEY: "kept",
    CLAUDECODE: "1", CLAUDE_EFFORT: "medium", CLAUDE_CODE_ENTRYPOINT: "sdk-cli", CLAUDE_CODE_SESSION_ID: "x",
    CLAUDE_CODE_MESSAGING_TOKEN: "t", CLAUDE_PID: "1", AI_AGENT: "claude-code", T3CODE_THREAD_ID: "y",
    CLAUDE_EFFORTLESS_NAME_LIKE: "dropped too", NOT_CLAUDE_X: "kept",
  }, { CLAUDE_CODE_TMPDIR: "/tmp/root", TMPDIR: "/tmp/root" });
  expect(env).toEqual({
    PATH: "/bin", HOME: "/home/a", ANTHROPIC_API_KEY: "kept", NOT_CLAUDE_X: "kept",
    AGENT_BOARD_HOOKS: "off", CLAUDE_CODE_TMPDIR: "/tmp/root", TMPDIR: "/tmp/root",
  });
  expect(childEnv({ AGENT_BOARD_HOOKS: "on" }).AGENT_BOARD_HOOKS).toBe("off");
  expect(childEnv({}, { AGENT_BOARD_HOOKS: "on" }).AGENT_BOARD_HOOKS).toBe("on");
});

test("output keeps UTF-8 characters split across byte-sized chunks", async () => {
  const code = 'const b=Buffer.from("明日の会議\\n中文意思");let i=0;const t=setInterval(()=>{process.stdout.write(b.subarray(i,i+1));if(++i===b.length)clearInterval(t)},2)';
  const result = await runProcess([bun, "-e", code]);
  expect(result.code).toBe(0);
  expect(result.stdout).toBe("明日の会議\n中文意思");
}, SPAWN_TIMEOUT);

test("exit codes, empty output and spawn errors are reported without hanging", async () => {
  expect((await runProcess([bun, "-e", "process.exit(7)"])).code).toBe(7);
  const empty = await runProcess([bun, "-e", "void 0"]);
  expect([empty.code, empty.stdout, empty.stderr]).toEqual([0, "", ""]);
  await expect(runProcess(["/nonexistent-test-executable"])).rejects.toThrow();
}, SPAWN_TIMEOUT);

test("input goes to stdin; a child that ignores it still exits cleanly", async () => {
  const echoed = await runProcess([bun, "-e", "process.stdin.pipe(process.stdout)"], { input: "через stdin 中文\n" });
  expect(echoed.stdout).toBe("через stdin 中文\n");
  const ignored = await runProcess([bun, "-e", "process.exit(3)"], { input: "x".repeat(1024 * 1024) });
  expect(ignored.code).toBe(3);
  const closed = await runProcess([bun, "-e", 'let n=0;process.stdin.on("data",(c)=>n+=c.length).on("end",()=>console.log(n))']);
  expect(closed.stdout.trim()).toBe("0");
}, SPAWN_TIMEOUT);

test("interact answers output while stdin stays open, and ends it itself", async () => {
  // The child echoes each line it reads and reports when stdin ends.
  const code = 'let b="";process.stdin.on("data",(c)=>{b+=c;let i;while((i=b.indexOf("\\n"))>=0){console.log("got "+b.slice(0,i));b=b.slice(i+1)}}).on("end",()=>console.log("end"))';
  const seen = [];
  const run = await runProcess([bun, "-e", code], {
    interact: (stdin) => {
      stdin.write("первый 中文\n");
      return (text) => {
        seen.push(text);
        if (text.includes("got первый 中文")) stdin.write("second\n");
        if (text.includes("got second")) stdin.end();
      };
    },
  });
  expect(run.stdout).toBe("got первый 中文\ngot second\nend\n");
  expect(seen.join("")).toBe(run.stdout);
  expect(() => runProcess([bun, "-e", "0"], { input: "x", interact: () => () => {} })).toThrow("not both");
}, SPAWN_TIMEOUT);

test("a listener that throws fails the run and kills the child", async () => {
  const error = await runProcess([bun, "-e", 'console.log("ready");setInterval(()=>{},1000)'], {
    interact: () => () => {
      throw new Error("listener failed");
    },
  }).catch((e) => e);
  expect(error.message).toBe("listener failed");
  expect(error.stdout).toBe("ready\n");
}, SPAWN_TIMEOUT);

test("an interact call that throws kills the child instead of leaking it", async () => {
  const started = Date.now();
  const error = await runProcess([bun, "-e", "setInterval(()=>{},1000)"], {
    timeout: 30_000,
    interact: () => {
      throw new Error("interact failed");
    },
  }).catch((e) => e);
  expect(error.message).toBe("interact failed");
  expect(Date.now() - started).toBeLessThan(10_000);
}, SCAN_TIMEOUT);

test("after a listener fails, later output no longer reaches it", async () => {
  let calls = 0;
  const code = 'let i=0;const t=setInterval(()=>{console.log("line "+i);if(++i===50)clearInterval(t)},1)';
  const error = await runProcess([bun, "-e", code], {
    interact: () => () => {
      calls++;
      throw new Error("listener failed");
    },
  }).catch((e) => e);
  expect(error.message).toBe("listener failed");
  expect(calls).toBe(1);
}, SPAWN_TIMEOUT);

test("a timeout also kills descendants that started their own process group", async () => {
  const root = mkdtempSync(join(tmpdir(), "process-test-"));
  const pidFile = join(root, "pid");
  let pid;
  try {
    // The child starts a detached grandchild (its own group, like a nested runProcess)
    // and stays alive itself, so the grandchild is still its descendant at the deadline.
    const code = `const {spawn}=require("node:child_process");const fs=require("node:fs");`
      + `const c=spawn("sleep",["30"],{detached:true,stdio:"ignore"});`
      + `fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000);`;
    const error = await runProcess([bun, "-e", code], { timeout: 1500 }).catch((e) => e);
    expect(error.message).toContain("timeout");
    pid = Number(readFileSync(pidFile, "utf8"));
    await Bun.sleep(150);
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    if (alive) expect((await runProcess(["ps", "-o", "stat=", "-p", String(pid)])).stdout.trim()).toMatch(/^Z/);
  } finally {
    if (pid) try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
    rmSync(root, { recursive: true, force: true });
  }
}, SCAN_TIMEOUT);

test("processesUnder finds a process working in a folder or naming it, and nothing else", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "process-under-")));
  const children = [];
  try {
    const idle = ["-e", "setInterval(()=>{},1000)"];
    children.push(spawn(bun, idle, { cwd: root, stdio: "ignore" }));
    children.push(spawn(bun, [...idle, join(root, "marker")], { stdio: "ignore" }));
    await Bun.sleep(300);
    expect(processesUnder(root).map((found) => found.pid).sort()).toEqual(children.map((child) => child.pid).sort());
    expect(processesUnder(join(root, "elsewhere"))).toEqual([]);
  } finally {
    for (const child of children) child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
  await Bun.sleep(200);
  expect(processesUnder(root)).toEqual([]);
}, SCAN_TIMEOUT);

test("stopLeftovers waits for exiting processes and kills the rest", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "process-leftovers-")));
  try {
    const exiting = spawn(bun, ["-e", "setTimeout(()=>{},300)"], { cwd: root, stdio: "ignore" });
    const lingering = spawn(bun, ["-e", "setInterval(()=>{},1000)"], { cwd: root, stdio: "ignore" });
    const exited = new Promise((resolve) => lingering.on("exit", (_code, signal) => resolve(signal)));
    await Bun.sleep(150);
    const left = await stopLeftovers(root, { graceMs: 1000 });
    expect(left.map((found) => found.pid)).toEqual([lingering.pid]);
    expect(await exited).toBe("SIGKILL");
    expect(exiting.exitCode).toBe(0);
    expect(await stopLeftovers(root, { graceMs: 0 })).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, SCAN_TIMEOUT);

test("stopLeftovers kills a leftover's whole process group, also members it cannot find", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "process-group-")));
  let hidden;
  try {
    // The leader works in root; its background child works outside root and names
    // nothing in it, so only the group leads to the child.
    const leader = spawn("sh", ["-c", "(cd / && exec sleep 30) & echo $!; exec sleep 30"], { cwd: root, detached: true, stdio: ["ignore", "pipe", "ignore"] });
    hidden = Number(await new Promise((resolve) => leader.stdout.once("data", (chunk) => resolve(String(chunk).trim()))));
    await Bun.sleep(150);
    expect(processesUnder(root).map((found) => found.pid)).toEqual([leader.pid]);
    expect((await stopLeftovers(root, { graceMs: 0 })).map((found) => found.pid)).toEqual([leader.pid]);
    await Bun.sleep(200);
    let alive = true;
    try {
      process.kill(hidden, 0);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
      alive = false;
    }
    expect(alive).toBe(false);
  } finally {
    try {
      process.kill(hidden, "SIGKILL");
    } catch {
      // Already gone.
    }
    rmSync(root, { recursive: true, force: true });
  }
}, SCAN_TIMEOUT);

test("a tracked run's background process stays findable after the run exits, until it is killed", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "process-tracked-")));
  const pidFile = join(root, "pid");
  const tracked = new Map();
  let pid;
  try {
    // The child leaves a detached task working outside root, which outlives it.
    const code = `const {spawn}=require("node:child_process");const fs=require("node:fs");`
      + `const c=spawn("sleep",["30"],{cwd:"/",detached:true,stdio:"ignore"});`
      + `fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));c.unref();setTimeout(()=>{},600);`;
    await runProcess([bun, "-e", code], { track: tracked, trackMs: 100 });
    pid = Number(readFileSync(pidFile, "utf8"));
    expect([...tracked.keys()]).toContain(pid);
    expect(processesUnder(root).map((found) => found.pid)).toEqual([]);
    expect(processesUnder(root, { tracked }).map((found) => found.pid)).toEqual([pid]);
    // A tracked pid whose start time differs is another process that reuses it.
    expect(processesUnder(root, { tracked: new Map([[pid, "Thu Jan  1 00:00:00 1970"]]) })).toEqual([]);
    expect((await stopLeftovers(root, { graceMs: 0, tracked })).map((found) => found.pid)).toEqual([pid]);
    await Bun.sleep(200);
    expect(processesUnder(root, { tracked })).toEqual([]);
  } finally {
    if (pid) try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
    rmSync(root, { recursive: true, force: true });
  }
}, SCAN_TIMEOUT);

test("stdout and stderr share one output bound", async () => {
  await expect(runProcess([bun, "-e", 'process.stdout.write("a".repeat(400));process.stderr.write("b".repeat(400))'], { maxBytes: 500 }))
    .rejects.toThrow("bound");
}, SPAWN_TIMEOUT);

test("output past the bound kills once, however many chunks follow", async () => {
  // A ps earlier on PATH logs each process-table scan, then runs the real one.
  const root = mkdtempSync(join(tmpdir(), "process-test-"));
  const log = join(root, "ps.log");
  writeFileSync(join(root, "ps"), `#!/bin/sh\necho scan >> "${log}"\nexec /bin/ps "$@"\n`);
  chmodSync(join(root, "ps"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${root}:${path}`;
  try {
    const code = 'const c="x".repeat(64);for(let i=0;i<2000;i++)process.stdout.write(c)';
    await expect(runProcess([bun, "-e", code], { maxBytes: 100 })).rejects.toThrow("bound");
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["scan"]);
  } finally {
    process.env.PATH = path;
    rmSync(root, { recursive: true, force: true });
  }
}, SCAN_TIMEOUT);

test("a timeout keeps the partial output and kills descendants after the leader exits", async () => {
  const root = mkdtempSync(join(tmpdir(), "process-test-"));
  const pidFile = join(root, "pid");
  let pid;
  try {
    const code = `const {spawn}=require("node:child_process");const fs=require("node:fs");console.log("partial");`
      + `const c=spawn("sleep",["30"],{stdio:["ignore",1,2]});`
      + `fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));c.unref();`;
    const error = await runProcess([bun, "-e", code], { timeout: 1500 }).catch((e) => e);
    expect(error.message).toContain("timeout");
    expect(error.stdout).toContain("partial");
    pid = Number(readFileSync(pidFile, "utf8"));
    await Bun.sleep(100);
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    if (alive) expect((await runProcess(["ps", "-o", "stat=", "-p", String(pid)])).stdout.trim()).toMatch(/^Z/);
  } finally {
    if (pid) try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
    rmSync(root, { recursive: true, force: true });
  }
}, SCAN_TIMEOUT);

test("processesUnder retries once on a transient empty-stderr ps failure and reports status on persistent failure", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "process-ps-retry-")));
  const marker = join(root, "failed-once");
  const ps = join(root, "ps");
  const path = process.env.PATH;
  process.env.PATH = `${root}:${path}`;
  try {
    writeFileSync(ps, `#!/bin/sh\nif [ ! -e "${marker}" ]; then touch "${marker}"; exit 1; fi\nexec /bin/ps "$@"\n`);
    chmodSync(ps, 0o755);
    expect(processesUnder(root)).toEqual([]);
    expect(existsSync(marker)).toBe(true);

    writeFileSync(ps, "#!/bin/sh\nexit 2\n");
    chmodSync(ps, 0o755);
    expect(() => processesUnder(root)).toThrow("ps failed: exit 2");
  } finally {
    process.env.PATH = path;
    rmSync(root, { recursive: true, force: true });
  }
}, SCAN_TIMEOUT);

test("timeout and abort kill tracked detached descendants and their whole process groups after their parent exits", async () => {
  for (const mode of ["timeout", "abort"]) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), `process-detached-${mode}-`)));
    const pidFile = join(root, "pids.json");
    const tracked = new Map();
    let leaderPid;
    let memberPid;
    try {
      // Child spawns an intermediate helper that launches a detached process group
      // (leader + background member) and exits, reparenting the detached group to PID 1
      // before the deadline or abort fires.
      const helper = `const {spawn}=require("node:child_process");const fs=require("node:fs");`
        + `const c=spawn("sh",["-c","(cd / && exec sleep 30) & echo $!; exec sleep 30"],{cwd:"/",detached:true,stdio:["ignore","pipe","ignore"]});`
        + `c.stdout.once("data",(chunk)=>{fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({leader:c.pid,member:Number(String(chunk).trim())}));c.unref();setTimeout(()=>process.exit(0),500);});`;
      const outer = `const {spawn}=require("node:child_process");spawn(${JSON.stringify(bun)},["-e",${JSON.stringify(helper)}],{stdio:"ignore"});setInterval(()=>{},1000);`;
      const controller = new AbortController();
      const abortTimer = mode === "abort" ? setTimeout(() => controller.abort(new Error("cancelled")), 1200) : null;
      const error = await runProcess([bun, "-e", outer], {
        timeout: mode === "timeout" ? 1500 : 15_000,
        track: tracked,
        trackMs: 100,
        signal: mode === "abort" ? controller.signal : undefined,
      }).catch((e) => e);
      if (abortTimer) clearTimeout(abortTimer);
      expect(error.message).toContain(mode === "timeout" ? "timeout" : "cancelled");
      ({ leader: leaderPid, member: memberPid } = JSON.parse(readFileSync(pidFile, "utf8")));
      await Bun.sleep(200);
      for (const pid of [leaderPid, memberPid]) {
        let alive = true;
        try {
          process.kill(pid, 0);
        } catch (err) {
          if (err.code !== "ESRCH") throw err;
          alive = false;
        }
        if (alive) expect((await runProcess(["ps", "-o", "stat=", "-p", String(pid)])).stdout.trim()).toMatch(/^Z/);
      }
      expect(processesUnder(root, { tracked })).toEqual([]);
    } finally {
      for (const target of [leaderPid ? -leaderPid : 0, leaderPid, memberPid]) {
        if (!target) continue;
        try {
          process.kill(target, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  }
}, SCAN_TIMEOUT);

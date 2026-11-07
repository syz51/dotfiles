// The factory's state folder: reports, scores, benchmark results and proposal records.
// It lives outside the repository, under XDG_DATA_HOME, or CLAUDE_FACTORY_STATE when set.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function stateDir(env = process.env) {
  if (env.CLAUDE_FACTORY_STATE) return env.CLAUDE_FACTORY_STATE;
  return join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "claude-factory");
}

// A path inside the state folder, with its parent folder created.
export function statePath(...parts) {
  const path = join(stateDir(), ...parts);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

export function appendJsonl(path, record) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`);
}

// Records of a JSON Lines file written by appendJsonl; [] when it does not exist yet.
// A malformed line means the file was damaged, so it fails with its location.
export function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((line) => line.trim()).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`${path}:${index + 1}: malformed JSON line`);
    }
  });
}

// Replaces path with value as JSON, so readers never see a half-written file.
export function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

export function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8"));
}

// A lock file holding the running process id, created atomically, so two runs starting
// together cannot both take it. A lock whose process is gone is taken over; a process we
// may not signal (EPERM) is alive.
export function acquireLock(path) {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, String(process.pid), { flag: "wx" });
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const pid = Number(readFileSync(path, "utf8"));
    if (pid) {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        if (error.code === "EPERM") return false;
        if (error.code !== "ESRCH") throw error;
      }
    }
    rmSync(path, { force: true });
  }
  return false;
}

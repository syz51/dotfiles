import { spawn } from "node:child_process";
export async function boundedProcess(
  command,
  { cwd, env, timeout = 180000, maxBytes = 2097152 } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out = [],
      err = [];
    let size = 0,
      failure;
    const kill = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      failure = Error("Process timeout");
      kill();
    }, timeout);
    for (const [stream, isOut] of [
      [child.stdout, true],
      [child.stderr, false],
    ])
      stream.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          failure = Error("Output bound exceeded");
          kill();
        } else (isOut ? out : err).push(Buffer.from(chunk));
      });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else
        resolve({
          code,
          out: Buffer.concat(out).toString("utf8"),
          err: Buffer.concat(err).toString("utf8"),
        });
    });
  });
}

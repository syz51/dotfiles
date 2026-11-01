import { writeFile, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { boundedProcess } from "./process.js";

// Capture bytes before the agent runs. Supplying no cwd deliberately avoids
// inferring relative read provenance from a thread's default directory.
export async function guidanceSnapshots(specs) {
  return Object.fromEntries(
    await Promise.all(
      specs.map(async ([name, path]) => [
        name,
        {
          path,
          content: await readFile(path, "utf8"),
          aliases: [await realpath(path)],
        },
      ]),
    ),
  );
}

export async function scoreGuidance(
  trace,
  targets,
  required,
  forbidden,
  before,
  scratch,
  sourceRecords = [],
  descendantSources = [],
) {
  const input = join(scratch, "guidance-request.json");
  await writeFile(
    input,
    JSON.stringify({
      trace_text: trace,
      targets,
      required,
      forbidden,
      before,
      cwd: null,
      source_records: sourceRecords,
      descendant_sources: descendantSources,
      home: homedir(),
    }),
  );
  const run = await boundedProcess(
    [
      "uv",
      "run",
      "--no-project",
      "python",
      "-B",
      fileURLToPath(
        new URL("../../scripts/ordinary_trace.py", import.meta.url),
      ),
      "--engine-root",
      join(homedir(), ".local/share/codex-skills/repository"),
      "--input-file",
      input,
    ],
    { timeout: 30000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } },
  );
  if (run.code !== 0) throw Error("Guidance scoring failed: " + run.err);
  for (const target of Object.values(targets))
    if ((await readFile(target.path, "utf8")) !== target.content)
      throw Error("Guidance changed during evaluation: " + target.path);
  return JSON.parse(run.out);
}

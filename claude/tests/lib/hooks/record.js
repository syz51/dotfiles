// Hook command for live tests: saves the hook input as one JSON file in the folder given
// as the first argument. A file per call keeps concurrent subagent hooks from interleaving.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const input = await Bun.stdin.text();
JSON.parse(input);
// Wall-clock microseconds order the files across processes; hrtime is per process.
const micros = Math.round((performance.timeOrigin + performance.now()) * 1000);
const name = `${String(micros).padStart(20, "0")}-${crypto.randomUUID()}.json`;
writeFileSync(join(process.argv[2], name), input);

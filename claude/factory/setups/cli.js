// `setups`: the setup registry (setups.toml at the repository root), the list of setups
// that agents name with `board feedback --about <id>` and that the feedback board's triage
// routes to their owners. --check validates it.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { REPO_ROOT } from "../scoring/rubric.js";

const USAGE = `Usage: bun ~/.claude/factory/cli.js setups [options]

Lists the setups in setups.toml, the ids agents report friction about.

  --check        validate the schema, unique ids and the repository paths in covers;
                 exit 1 on any problem
  --file PATH    registry file (default: setups.toml at the repository root)
  --json         print the setups as JSON
  --help`;

export const REGISTRY = join(REPO_ROOT, "setups.toml");
export const ID = /^[a-z0-9:_-]{1,40}$/;
const CHANNELS = new Set(["board", "skill-notes"]);
const FIELDS = new Set(["id", "title", "covers", "owner", "channel", "change", "verify"]);
const OWNER_FIELDS = new Set(["repo", "board", "parent"]);
// Ids every registry must have: the setups the feedback loop names in its instructions.
export const REQUIRED = ["board", "instructions", "agents", "hooks", "settings", "skills", "work-stages", "factory", "storage", "t3", "project", "other"];
// The owner of a project's own setup: whichever project the report came from.
const PROJECT = "<project>";
const BOARD = /^[a-z0-9][a-z0-9-]*$/;
const TASK = /^[a-z0-9][a-z0-9-]*-\d+$/;

// A covers entry without whitespace is a path relative to the repository root; one with
// whitespace describes what the setup is.
export const isPath = (entry) => !/\s/.test(entry);

const text = (value) => typeof value === "string" && value.trim() !== "";
const texts = (value) => Array.isArray(value) && value.length > 0 && value.every(text);

// Problems with one parsed registry, as messages naming the setup; [] when it is valid.
export function problems(registry, { root = REPO_ROOT } = {}) {
  const list = registry?.setup;
  if (!Array.isArray(list) || !list.length) return ["no [[setup]] entries"];
  const found = [];
  const seen = new Set();
  list.forEach((setup, index) => {
    const name = text(setup?.id) ? setup.id : `setup ${index + 1}`;
    const bad = (message) => found.push(`${name}: ${message}`);
    for (const key of Object.keys(setup ?? {})) if (!FIELDS.has(key)) bad(`unknown field ${key}`);
    if (!text(setup?.id) || !ID.test(setup.id)) bad("id must be 1-40 characters of [a-z0-9:_-]");
    else if (seen.has(setup.id)) bad("duplicate id");
    else seen.add(setup.id);
    if (!text(setup?.title)) bad("title must be a non-empty string");
    if (!text(setup?.change)) bad("change must be a non-empty string");
    if (!texts(setup?.verify)) bad("verify must be a non-empty list of commands");
    if (!CHANNELS.has(setup?.channel)) bad(`channel must be one of ${[...CHANNELS].join(", ")}`);
    if (!texts(setup?.covers)) bad("covers must be a non-empty list");
    else
      for (const entry of setup.covers.filter(isPath))
        if (entry.startsWith("/") || entry.split("/").includes("..")) bad(`covers path ${entry} must stay inside the repository`);
        else if (!existsSync(join(root, entry))) bad(`covers path ${entry} does not exist`);
    const owner = setup?.owner;
    if (!owner || typeof owner !== "object" || Array.isArray(owner)) bad("owner must be a table with repo and board");
    else {
      for (const key of Object.keys(owner)) if (!OWNER_FIELDS.has(key)) bad(`unknown owner field ${key}`);
      if (!text(owner.repo)) bad("owner.repo must be a non-empty string");
      // A skill-notes setup records feedback in the skill itself, so it needs no board.
      if (owner.board === undefined ? setup.channel !== "skill-notes" : !(owner.board === PROJECT || BOARD.test(owner.board ?? "")))
        bad(`owner.board must be a board slug or ${PROJECT}`);
      if (owner.parent !== undefined && !TASK.test(owner.parent)) bad("owner.parent must be a task id such as vps-44");
    }
  });
  for (const id of REQUIRED) if (!seen.has(id)) found.push(`missing required setup ${id}`);
  return found;
}

// The parsed registry; a file that does not parse fails with its path.
export function readRegistry(path = REGISTRY) {
  try {
    return Bun.TOML.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path}: ${error.message}`);
  }
}

// Valid setups, or an error listing every problem.
export function loadSetups(path = REGISTRY, { root = REPO_ROOT } = {}) {
  const registry = readRegistry(path);
  const found = problems(registry, { root });
  if (found.length) throw new Error(`${path} is invalid:\n- ${found.join("\n- ")}`);
  return registry.setup;
}

export async function run(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      options: {
        check: { type: "boolean", default: false },
        file: { type: "string", default: REGISTRY },
        json: { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
    }));
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  let registry;
  try {
    registry = readRegistry(values.file);
  } catch (error) {
    console.error(error.message);
    return 1;
  }
  const found = problems(registry);
  if (values.check) {
    if (found.length) {
      console.error(`${values.file} is invalid:\n- ${found.join("\n- ")}`);
      return 1;
    }
    console.log(`${values.file}: ${registry.setup.length} setups, valid.`);
    return 0;
  }
  if (values.json) console.log(JSON.stringify(registry.setup ?? [], null, 2));
  else {
    const setups = registry.setup ?? [];
    const width = Math.max(...setups.map((setup) => String(setup.id).length));
    for (const setup of setups) console.log(`${String(setup.id).padEnd(width)}  ${setup.title}  (${setup.owner?.board ?? setup.channel})`);
  }
  if (found.length) console.error(`\n${found.length} problems; run with --check for the list.`);
  return found.length ? 1 : 0;
}

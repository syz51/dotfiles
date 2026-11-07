import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPath, loadSetups, problems, REQUIRED, run } from "./cli.js";

let scratch;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "claude-factory-setups-"));
  spyOn(console, "log").mockImplementation(() => {});
  spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  console.log.mockRestore();
  console.error.mockRestore();
  rmSync(scratch, { recursive: true, force: true });
});

const setup = (id, extra = {}) => ({ id, title: `The ${id}`, covers: ["a phrase with spaces"], owner: { repo: "github.com/o/r", board: "dotfiles" }, channel: "board", change: "A PR", verify: ["true"], ...extra });
const valid = () => ({ setup: REQUIRED.map((id) => setup(id)) });

describe("setups", () => {
  test("the real registry is valid, and --check exits 0 on it", async () => {
    expect(problems(Bun.TOML.parse(await Bun.file(join(import.meta.dir, "..", "..", "..", "setups.toml")).text()))).toEqual([]);
    expect(await run(["--check"])).toBe(0);
    const ids = loadSetups().map((entry) => entry.id);
    for (const id of REQUIRED) expect(ids).toContain(id);
    expect(loadSetups().find((entry) => entry.id === "storage").owner).toEqual({ repo: "github.com/syz51/vps", board: "vps", parent: "vps-44" });
    expect(loadSetups().find((entry) => entry.id === "skills").channel).toBe("skill-notes");
    // CI friction goes to the board of the repository whose workflows or branch rules got in the way.
    expect(loadSetups().find((entry) => entry.id === "ci").owner).toEqual({ repo: "<project>", board: "<project>" });
  });

  test("--check exits 1 on a broken registry and names each problem", async () => {
    const file = join(scratch, "setups.toml");
    writeFileSync(file, `[[setup]]
id = "board"
title = "Board"
covers = ["missing/path"]
owner = { repo = "r", board = "agent-board" }
channel = "email"
change = "x"
verify = ["y"]
colour = "red"

[[setup]]
id = "board"
title = ""
covers = []
owner = { repo = "r", board = "Not A Board", parent = "vps" }
channel = "board"
change = "x"
verify = []

[[setup]]
id = "Bad Id"
title = "t"
covers = ["../outside"]
channel = "board"
change = "x"
verify = ["y"]
`);
    expect(await run(["--check", "--file", file])).toBe(1);
    const message = console.error.mock.calls.flat().join("\n");
    for (const expected of ["board: unknown field colour", "board: channel must be one of board, skill-notes", "board: covers path missing/path does not exist",
      "board: duplicate id", "board: title must be a non-empty string", "board: covers must be a non-empty list", "board: verify must be a non-empty list",
      "board: owner.board must be a board slug or <project>", "board: owner.parent must be a task id", "Bad Id: id must be 1-40 characters",
      "Bad Id: covers path ../outside must stay inside the repository", "Bad Id: owner must be a table", "missing required setup instructions"])
      expect(message).toContain(expected);
    writeFileSync(file, "not = [toml");
    expect(await run(["--check", "--file", file])).toBe(1);
  });

  test("paths in covers must exist; phrases are not checked", () => {
    mkdirSync(join(scratch, "tool"));
    const registry = valid();
    registry.setup[0].covers = ["tool", "anything at all, described"];
    expect(problems(registry, { root: scratch })).toEqual([]);
    registry.setup[0].covers.push("gone");
    expect(problems(registry, { root: scratch })).toEqual([`${REQUIRED[0]}: covers path gone does not exist`]);
    // A run reading the registry checks the schema only; whether paths exist is --check's.
    expect(problems(registry, { root: scratch, paths: false })).toEqual([]);
    const file = join(scratch, "setups.toml");
    writeFileSync(file, registry.setup.map((entry) => `[[setup]]\n${Object.entries(entry).map(([key, value]) => `${key} = ${JSON.stringify(value).replace(/"(\w+)":/g, "$1 = ").replace(/^\{/, "{ ").replace(/\}$/, " }")}`).join("\n")}\n`).join("\n"));
    expect(loadSetups(file, { root: scratch, paths: false })).toHaveLength(REQUIRED.length);
    expect(() => loadSetups(file, { root: scratch })).toThrow("covers path gone does not exist");
    expect([isPath("claude/factory"), isPath("the board server")]).toEqual([true, false]);
  });

  test("owners: <project> and skill-notes setups without a board are valid; ids are bounded", () => {
    const registry = valid();
    registry.setup.find((entry) => entry.id === "project").owner = { repo: "<project>", board: "<project>" };
    Object.assign(registry.setup.find((entry) => entry.id === "skills"), { channel: "skill-notes", owner: { repo: "codex-skills" } });
    registry.setup.push(setup("a:b_c-1"), setup("x".repeat(41)));
    expect(problems(registry)).toEqual([`${"x".repeat(41)}: id must be 1-40 characters of [a-z0-9:_-]`]);
    registry.setup.pop();
    registry.setup.find((entry) => entry.id === "other").owner = { repo: "r" };
    expect(problems(registry)).toEqual(["other: owner.board must be a board slug or <project>"]);
  });
});

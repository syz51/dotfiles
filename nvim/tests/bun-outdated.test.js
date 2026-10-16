import { expect, test } from "bun:test";
import { parseOutdated } from "../scripts/bun-outdated.js";

test("converts Bun rows and registry aliases to package-info data", () => {
  const result = parseOutdated(
    `bun outdated v1.3.14 (0d9b296a)
|---------------------------------------------|
| Package         | Current | Update | Latest |
|-----------------|---------|--------|--------|
| is-number       | 6.0.0   | 6.0.0  | 7.0.0  |
| is-odd (dev)    | 2.0.0   | 2.0.0  | 3.0.1  |
| @scope/pkg      | 1.0.0   | 1.2.0  | 2.0.0  |
|---------------------------------------------|
`,
    {
      "is-number": "6.0.0",
      "number-alias": "npm:is-number@6.0.0",
      "is-odd": "2.0.0",
      "scoped-alias": "npm:@scope/pkg@1.0.0",
    },
  );
  expect(result["is-number"]).toEqual({ current: "6.0.0", wanted: "6.0.0", latest: "7.0.0" });
  expect(result["number-alias"]).toEqual(result["is-number"]);
  expect(result["is-odd"].latest).toBe("3.0.1");
  expect(result["scoped-alias"].latest).toBe("2.0.0");
});

test("accepts boxed tables, workspace columns and qualified alias names", () => {
  expect(
    parseOutdated(
      `┌───────────────────────────┬─────────┬─────────┬─────────┬───────────┐
│ Package                   │ Current │ Update  │ Latest  │ Workspace │
├───────────────────────────┼─────────┼─────────┼─────────┼───────────┤
│ alias@npm:is-number (dev) │ 6.0.0   │ 6.0.0   │ 7.0.0   │ app       │
└───────────────────────────┴─────────┴─────────┴─────────┴───────────┘`,
      { alias: "npm:is-number@6.0.0" },
    ),
  ).toEqual({ alias: { current: "6.0.0", wanted: "6.0.0", latest: "7.0.0" } });
});

test("returns no outdated packages when Bun prints only its banner", () => {
  expect(parseOutdated("bun outdated v1.3.14 (0d9b296a)\n", {})).toEqual({});
});

test("rejects unexpected output instead of reporting packages as up to date", () => {
  expect(() => parseOutdated("unexpected format", {})).toThrow("Unrecognized bun outdated output");
  expect(() => parseOutdated("| is-number | 6.0.0 | 6.0.0 | unknown |", {})).toThrow();
});

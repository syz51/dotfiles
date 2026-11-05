#!/usr/bin/env bun
// A stand-in for `gh` in the metrics tests. It appends its argv as one JSON line to
// FAKE_GH_LOG and answers from the JSON file at FAKE_GH_DATA:
//   { "prs": { "<PR URL>": { ...gh pr view fields } },
//     "reverts": { "<owner/repo>": [ ...gh pr list items ] } }
// An entry of { "fail": "message" } (or a missing one) fails like gh does: the message on
// stderr and exit status 1.
import { appendFileSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const env = process.env;
if (env.FAKE_GH_LOG) appendFileSync(env.FAKE_GH_LOG, `${JSON.stringify(args)}\n`);
const data = JSON.parse(readFileSync(env.FAKE_GH_DATA, "utf8"));
const option = (name) => args[args.indexOf(name) + 1];

let answer;
if (args[0] === "pr" && args[1] === "view") answer = data.prs?.[args[2]] ?? { fail: `GraphQL: Could not resolve to a PullRequest (${args[2]})` };
else if (args[0] === "pr" && args[1] === "list") answer = data.reverts?.[option("--repo")] ?? { fail: `GraphQL: Could not resolve to a Repository (${option("--repo")})` };
else answer = { fail: `unknown command: ${args.join(" ")}` };

if (answer && !Array.isArray(answer) && answer.fail) {
  console.error(answer.fail);
  process.exit(1);
}
console.log(JSON.stringify(answer));

// `audit`: report the security posture of this Claude Code setup. Exits 1 when a finding
// at or above --fail-on is not accepted in the baseline, 2 on a usage error.
import { parseArgs } from "node:util";
import { join } from "node:path";
import { readJson, stateDir, writeJsonAtomic } from "../lib/state.js";
import { SEVERITIES, audit, auditPaths, rank } from "./audit.js";

const USAGE = `Usage: bun ~/.claude/factory/cli.js audit [options]

Reads ~/.claude (or CLAUDE_CONFIG_DIR) settings, hooks, agents, MCP servers in .claude.json
(names and types only) and the codex-skills weekly review, and reports findings by severity.

Options:
  --json                 Print findings as JSON
  --with-tests           Also run bun test over claude/hooks
  --baseline <path>      Accepted findings (default: <state>/audit-baseline.json)
  --update-baseline      Accept every current finding into the baseline, then exit 0;
                         a finding that later grows more severe is no longer accepted
  --fail-on <severity>   Exit 1 on a finding at or above it that the baseline lacks:
                         ${[...SEVERITIES].reverse().join(", ")} or none (default: medium)
  --codex-skills <path>  codex-skills checkout (default: ~/.local/share/codex-skills/repository)
  -h, --help             Show this help`;

const OPTIONS = {
  json: { type: "boolean" },
  "with-tests": { type: "boolean" },
  baseline: { type: "string" },
  "update-baseline": { type: "boolean" },
  "fail-on": { type: "string", default: "medium" },
  "codex-skills": { type: "string" },
  help: { type: "boolean", short: "h" },
};

function parse(argv) {
  const { values } = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: false });
  if (values["fail-on"] !== "none" && !SEVERITIES.includes(values["fail-on"]))
    throw new Error(`--fail-on must be one of ${SEVERITIES.join(", ")} or none`);
  return values;
}

function readBaseline(path) {
  const baseline = readJson(path, { accepted: {} });
  if (!baseline || typeof baseline.accepted !== "object" || Array.isArray(baseline.accepted))
    throw new Error(`${path}: not an audit baseline (expected an "accepted" object)`);
  return baseline;
}

function text(findings, { failOn, failing, baselinePath }) {
  const lines = [];
  for (const severity of [...SEVERITIES].reverse()) {
    const group = findings.filter((item) => item.severity === severity);
    if (!group.length) continue;
    lines.push(`${severity.toUpperCase()} (${group.length})`);
    for (const item of group) {
      lines.push(`  ${item.accepted ? "[accepted] " : ""}${item.title}`);
      lines.push(`    id: ${item.id}`);
      if (item.fix !== "None needed") lines.push(`    fix: ${item.fix}`);
    }
  }
  const counts = SEVERITIES.map((severity) => `${findings.filter((item) => item.severity === severity).length} ${severity}`).reverse();
  lines.push("", `${findings.length} findings: ${counts.join(", ")}. Baseline: ${baselinePath}`);
  if (failOn === "none") lines.push("--fail-on none: not failing.");
  else if (failing.length) lines.push(`${failing.length} finding${failing.length > 1 ? "s" : ""} at or above ${failOn} not in the baseline: ${failing.join(", ")}`);
  else lines.push(`No finding at or above ${failOn} outside the baseline.`);
  return lines.join("\n");
}

export async function run(argv) {
  let options;
  try {
    options = parse(argv);
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  const baselinePath = options.baseline ?? join(stateDir(), "audit-baseline.json");
  const paths = auditPaths(process.env, { codexSkills: options["codex-skills"] });
  const findings = await audit({ paths, withTests: options["with-tests"] });

  if (options["update-baseline"]) {
    const accepted = Object.fromEntries(findings.map(({ id, severity, title }) => [id, { severity, title }]));
    writeJsonAtomic(baselinePath, { version: 1, updatedAt: new Date().toISOString(), accepted });
    console.log(`Accepted ${findings.length} findings into ${baselinePath}`);
    return 0;
  }

  const { accepted } = readBaseline(baselinePath);
  const failOn = options["fail-on"];
  // A finding stays accepted only while it is no more severe than when it was accepted.
  for (const item of findings)
    item.accepted = Object.hasOwn(accepted, item.id) && rank(item.severity) <= rank(accepted[item.id]?.severity ?? "high");
  const failing = failOn === "none" ? [] : findings.filter((item) => !item.accepted && rank(item.severity) >= rank(failOn)).map((item) => item.id);
  if (options.json) console.log(JSON.stringify({ findings, baseline: baselinePath, failOn, failing }, null, 2));
  else console.log(text(findings, { failOn, failing, baselinePath }));
  return failing.length ? 1 : 0;
}

// LaunchAgents for the factory's scheduled runs: the plist, and loading, unloading and
// checking it in the user's launchd domain. CLAUDE_FACTORY_LAUNCH_AGENTS and
// CLAUDE_FACTORY_LAUNCHCTL replace the LaunchAgents folder and launchctl (tests use fakes).
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { runProcess } from "../../tests/lib/process.js";

const xml = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// The schedule as plist keys: { weekday, hour, minute } for a calendar time (launchd runs
// a missed one once when the Mac wakes), or { everySeconds } for an interval.
function scheduleKeys(schedule) {
  if (schedule.everySeconds) return `\t<key>StartInterval</key>\n\t<integer>${schedule.everySeconds}</integer>`;
  const keys = [["Weekday", schedule.weekday], ["Hour", schedule.hour], ["Minute", schedule.minute]].filter(([, value]) => value !== undefined);
  return `\t<key>StartCalendarInterval</key>\n\t<dict>\n${keys.map(([key, value]) => `\t\t<key>${key}</key>\n\t\t<integer>${value}</integer>`).join("\n")}\n\t</dict>`;
}

// A LaunchAgent plist that runs args with HOME and PATH set, logging to
// <logs>/<logName>-launchd.log and -launchd-error.log.
export function plistText({ label, args, schedule, path, home = homedir(), logs, logName }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${xml(label)}</string>
\t<key>ProgramArguments</key>
\t<array>
${args.map((item) => `\t\t<string>${xml(item)}</string>`).join("\n")}
\t</array>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>HOME</key>
\t\t<string>${xml(home)}</string>
\t\t<key>PATH</key>
\t\t<string>${xml(path)}</string>
\t</dict>
${scheduleKeys(schedule)}
\t<key>ProcessType</key>
\t<string>Background</string>
\t<key>StandardOutPath</key>
\t<string>${xml(join(logs, `${logName}-launchd.log`))}</string>
\t<key>StandardErrorPath</key>
\t<string>${xml(join(logs, `${logName}-launchd-error.log`))}</string>
</dict>
</plist>
`;
}

const agentsDir = () => process.env.CLAUDE_FACTORY_LAUNCH_AGENTS || join(homedir(), "Library", "LaunchAgents");
export const plistPath = (label) => join(agentsDir(), `${label}.plist`);
const launchctl = (args) => runProcess([process.env.CLAUDE_FACTORY_LAUNCHCTL || "launchctl", ...args], { timeout: 30_000 });
const domain = () => `gui/${userInfo().uid}`;

// A PATH for the job holding the folders of tools found on this PATH, so launchd's minimal
// PATH can reach them, then bun's and the system's. A missing required tool fails, naming
// what it is needed for; a missing optional one is left out.
export async function toolPath({ required = [], optional = [], purpose }) {
  const dirs = new Set();
  for (const tool of [...required, ...optional]) {
    const found = await runProcess(["/usr/bin/which", tool], { timeout: 10_000 });
    if (found.code !== 0) {
      if (optional.includes(tool)) continue;
      throw new Error(`${tool} is not on PATH; install it before scheduling ${purpose}`);
    }
    dirs.add(dirname(found.stdout.trim()));
  }
  return [...dirs, dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
}

// Writes the plist and loads it, replacing a loaded copy. Returns an exit code.
export async function installAgent(label, text, { logs }) {
  mkdirSync(logs, { recursive: true });
  mkdirSync(agentsDir(), { recursive: true });
  // bootout fails harmlessly when none is loaded.
  await launchctl(["bootout", `${domain()}/${label}`]);
  writeFileSync(plistPath(label), text);
  const loaded = await launchctl(["bootstrap", domain(), plistPath(label)]);
  if (loaded.code !== 0) {
    console.error(`launchctl bootstrap failed (exit ${loaded.code}): ${loaded.stderr.trim()}`);
    return 1;
  }
  return 0;
}

export async function uninstallAgent(label) {
  await launchctl(["bootout", `${domain()}/${label}`]);
  rmSync(plistPath(label), { force: true });
}

// "LaunchAgent: <plist or not installed>; loaded|not loaded".
export async function agentStatus(label) {
  const loaded = await launchctl(["print", `${domain()}/${label}`]);
  return `LaunchAgent: ${existsSync(plistPath(label)) ? plistPath(label) : "not installed"}; ${loaded.code === 0 ? "loaded" : "not loaded"}`;
}

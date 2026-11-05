#!/usr/bin/env bun
// Entry point: bun ~/.claude/factory/cli.js <command> [options]. Each command lives in its
// own folder and exports run(argv), which returns the process exit code.
const COMMANDS = {
  metrics: ["./metrics/cli.js", "Outcome metrics per session and PR, with trends"],
  score: ["./scoring/score.js", "Score recent sessions against the rubric"],
  propose: ["./scoring/propose.js", "Propose configuration fixes for repeated failures"],
  bench: ["./bench/cli.js", "Benchmark model and effort configurations on real tasks"],
  audit: ["./audit/cli.js", "Audit the security posture of this setup"],
};

function usage() {
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length));
  return ["Usage: bun ~/.claude/factory/cli.js <command> [options]", "",
    ...Object.entries(COMMANDS).map(([name, [, summary]]) => `  ${name.padEnd(width)}  ${summary}`),
    "", "Run a command with --help for its options."].join("\n");
}

export async function main(argv) {
  const [name, ...rest] = argv;
  if (!name || name === "--help" || name === "-h") {
    console.log(usage());
    return name ? 0 : 2;
  }
  const command = COMMANDS[name];
  if (!command) {
    console.error(`Unknown command: ${name}\n\n${usage()}`);
    return 2;
  }
  const module = await import(command[0]);
  return (await module.run(rest)) ?? 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));

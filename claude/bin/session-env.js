// The variables a running Claude Code session, or the app hosting it, puts in its tools'
// environment: the one list that claude/bin/no-session-env and the test harness's child
// processes (claude/tests/lib/process.js) both remove. A `claude` started with them acts
// as a child of that session: it logs the session's entrypoint, takes its flags and keeps
// its messaging token.
export const SESSION_VARIABLE = /^(?:CLAUDECODE|CLAUDE_\w*|AI_AGENT|T3CODE_\w*)$/;

export const sessionVariables = (env) => Object.keys(env).filter((name) => SESSION_VARIABLE.test(name));

// Prints the names of the session variables in this process's environment, one per line,
// for claude/bin/no-session-env to unset.
if (import.meta.main) for (const name of sessionVariables(process.env)) console.log(name);

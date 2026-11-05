// Prompts a person typed, after removing what the host app sends in the person's name.
// lib/transcripts.js already drops meta, injected and system prompts; T3 Code still sends
// some notices as ordinary sdk prompts (pull request updates, delegated-task results,
// resume nudges), and slash commands arrive as <command-name> markup.
const HOST_PROMPT = [
  /^\s*<command-name>/, // a slash command such as /compact
  /^Update on pull request #\d+ \(https:\/\/github\.com\//,
  /^Pull request #\d+ \(https:\/\/github\.com\/[^)]+\) was (?:closed|merged)/,
  /^Delegated task node:delegated-task:/,
  /^Continue where you left off\./,
];

export const isHostPrompt = (text) => HOST_PROMPT.some((pattern) => pattern.test(text));

// The session's prompts without host notices, in order.
export const humanPrompts = (session) => session.prompts.filter((prompt) => !isHostPrompt(prompt.text));

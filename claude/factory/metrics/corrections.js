// A heuristic for follow-up prompts in which the person corrects the agent: rejections
// ("no, ...", "wrong"), restatements ("I meant", "I said"), reports that the work still
// fails, and "why did you" complaints. It reads only the prompt text, so it misses quiet
// corrections and catches some questions; reports label it as a heuristic, and the
// scoring judge refines it. A session's first prompt is the task, never a correction.
import { isHostPrompt } from "./prompts.js";

// Only the start of a prompt is read: long prompts are mostly quoted output or new tasks.
const READ = 400;
// A reply often starts with a line quoted from the agent's report ("> ..." or a
// "**Heading:** ..." item); the person's own words follow it.
const QUOTED = /^\s*(?:>|\*\*[^*\n]+\*\*)/;

function ownWords(text) {
  const lines = text.split("\n");
  while (lines.length > 1 && QUOTED.test(lines[0])) lines.shift();
  return lines.join("\n");
}

const CORRECTION = [
  // A leading "no" or "nope", but not "no problem", "no worries", "no thanks", "no need".
  /^(?:no|nope|nah)\b(?![\s,.!-]*(?:problem|worries|worry|thanks|thank|need|rush|pressure|hurry)\b)/,
  /^not\s+(?:with|like|that|this|what|quite|really|exactly|there|in)\b/,
  /^(?:stop|undo|never\s?mind)\b/,
  /\b(?:wrong|incorrect)\b/,
  /\bthat'?s not (?:it|right|what|how|correct)\b/,
  /\bnot what i\b/,
  /\bi (?:meant|mean|said|told you|asked (?:you|for))\b/,
  /\bas i (?:said|mentioned|asked)\b/,
  /\byou (?:didn'?t|did not|forgot|missed|ignored|broke|skipped|keep|still|were supposed|should have|shouldn'?t have)\b/,
  /\bi thought you\b/,
  /\bwhy (?:did|do|are|were|would|is|was) you\b/,
  /\bwhy (?:is|was|are) (?:it|this|that|the \w+)\b.*\bagain\b/,
  /\b(?:doesn'?t|does not|didn'?t|did not|isn'?t|is not|still not) work(?:s|ing)?\b/,
  /\bnot working\b/,
  /\bstill (?:broken|failing|fails|wrong|not|doesn'?t|isn'?t|there|running|using|showing|happening)\b/,
  /\b(?:failed|failing|broken|broke) again\b/,
  /\b(?:revert|undo) (?:that|this|it|the change)\b/,
  /^instead of\b/,
];

export function isCorrection(text) {
  if (typeof text !== "string" || isHostPrompt(text)) return false;
  const start = ownWords(text).slice(0, READ).trim().toLowerCase().replace(/[‘’]/g, "'");
  return CORRECTION.some((pattern) => pattern.test(start));
}

// Corrections among a session's follow-up prompts; prompts are the person's prompts in
// order (see humanPrompts), so the first one is skipped.
export function countCorrections(prompts) {
  const followUps = prompts.slice(1);
  return { followUps: followUps.length, corrections: followUps.filter((prompt) => isCorrection(prompt.text)).length };
}

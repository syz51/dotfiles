// Worker thread of loadSessionsParallel in transcripts.js: parses its share of the listed
// transcripts and answers once, with each session beside its place in the list. A file that
// is gone is left out, as loadSessions does; any other error goes back to fail the load.
import { parseListedFile } from "./transcripts.js";

self.onmessage = ({ data: share }) => {
  try {
    const sessions = [];
    for (const entry of share) {
      const session = parseListedFile(entry);
      if (session) sessions.push({ index: entry.index, session });
    }
    postMessage({ sessions });
  } catch (error) {
    postMessage({ error: { message: error.message, code: error.code, stack: error.stack } });
  }
};

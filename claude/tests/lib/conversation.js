// A two-message print-mode conversation over `--input-format stream-json`: the prompt,
// then a follow-up sent as soon as the first turn ends, as a person typing while the
// session still works in the background. Closing stdin stops the session's background
// tasks, so stdin stays open until a later turn ends with none left.

export const userMessage = (text) => `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`;

// An interact function for runProcess. Lines that do not parse are skipped here; the
// harness's own stream parsing reports them.
export function conversation(prompt, followUp) {
  return (stdin) => {
    stdin.write(userMessage(prompt));
    let pending = "";
    let sent = false;
    let background = [];
    return (text) => {
      const lines = (pending + text).split("\n");
      pending = lines.pop();
      for (const line of lines) {
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type === "system" && event.subtype === "background_tasks_changed") background = event.tasks ?? [];
        if (event.type !== "result" || stdin.writableEnded) continue;
        if (!sent) {
          sent = true;
          stdin.write(userMessage(followUp));
        } else if (!background.length) stdin.end();
      }
    };
  };
}

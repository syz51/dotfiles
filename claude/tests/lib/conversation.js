// A print-mode conversation over `--input-format stream-json`: the prompt, then a
// follow-up sent as soon as the first turn ends, as a person typing while the session
// still works in the background. Closing stdin stops the session's background tasks, so
// stdin stays open until a later turn ends with none left. A task that ends always
// starts a turn, whose result then closes stdin. Without a follow-up, stdin closes when
// the first turn ends, as when a person reads the answer and leaves: whatever the
// session left running in the background is stopped then, and the stream shows it.

export const userMessage = (text) => `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`;

// An interact function for runProcess. A line that does not parse throws, which fails
// the run with its cause instead of leaving it to hang until the deadline.
export function conversation(prompt, followUp) {
  return (stdin) => {
    stdin.write(userMessage(prompt));
    let pending = "";
    let sent = false;
    let background = [];
    return (text) => {
      // Only text up to the last newline holds whole lines; the rest waits for the next chunk.
      const last = text.lastIndexOf("\n");
      if (last < 0) {
        pending += text;
        return;
      }
      const lines = (pending + text.slice(0, last)).split("\n");
      pending = text.slice(last + 1);
      for (const line of lines) {
        if (!line.trim()) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          throw new Error(`Malformed stream line: ${line.slice(0, 200)}`);
        }
        // Ambient tasks, such as watchers Claude Code starts itself, are not the session's work.
        if (event.type === "system" && event.subtype === "background_tasks_changed")
          background = (event.tasks ?? []).filter((task) => !task.ambient);
        if (event.type !== "result" || stdin.writableEnded) continue;
        if (followUp === undefined) stdin.end();
        else if (!sent) {
          sent = true;
          stdin.write(userMessage(followUp));
        } else if (!background.length) stdin.end();
      }
    };
  };
}

import { expect, test } from "bun:test";
import { conversation, userMessage } from "./conversation.js";

// A stand-in for a child's stdin that records what was written and whether it ended.
function fakeStdin() {
  return {
    writes: [],
    writableEnded: false,
    write(text) {
      this.writes.push(JSON.parse(text).message.content);
    },
    end() {
      this.writableEnded = true;
    },
  };
}

const line = (event) => `${JSON.stringify(event)}\n`;
const result = (text) => line({ type: "result", subtype: "success", result: text });
const background = (...ids) => line({ type: "system", subtype: "background_tasks_changed", tasks: ids.map((task_id) => ({ task_id })) });

test("user messages are stream-json input lines", () => {
  expect(JSON.parse(userMessage("hi"))).toEqual({ type: "user", message: { role: "user", content: "hi" } });
  expect(userMessage("hi")).toEndWith("\n");
});

test("the follow-up goes out when the first turn ends; stdin ends once a turn ends with no background task", () => {
  const stdin = fakeStdin();
  const listen = conversation("review it", "what is 17 * 23?")(stdin);
  expect(stdin.writes).toEqual(["review it"]);
  listen(background("review"));
  // A result split across chunks counts once it is whole.
  const first = result("The review is running.");
  listen(first.slice(0, 10));
  expect(stdin.writes).toEqual(["review it"]);
  listen(first.slice(10));
  expect(stdin.writes).toEqual(["review it", "what is 17 * 23?"]);
  // The follow-up's answer ends a turn while the review still runs: stdin stays open.
  listen(result("391"));
  expect(stdin.writableEnded).toBe(false);
  listen(`not json\n${background()}`);
  expect(stdin.writableEnded).toBe(false);
  listen(result("The review found one defect."));
  expect(stdin.writableEnded).toBe(true);
  listen(result("late"));
  expect(stdin.writes).toHaveLength(2);
});

test("a session with no background work ends after the follow-up's turn", () => {
  const stdin = fakeStdin();
  const listen = conversation("review it", "what is 17 * 23?")(stdin);
  listen(result("Findings: none.") + result("391"));
  expect(stdin.writes).toEqual(["review it", "what is 17 * 23?"]);
  expect(stdin.writableEnded).toBe(true);
});

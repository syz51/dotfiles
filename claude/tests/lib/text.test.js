import { expect, test } from "bun:test";
import { chineseLines, hasKana, singleChineseLine } from "./text.js";

const japanese = "承知いたしました。明日の会議に出席いたします。";

test("Japanese is recognized by its kana", () => {
  expect(hasKana(japanese)).toBe(true);
  expect(hasKana("我会参加明天的会议。")).toBe(false);
});

test("a Chinese meaning after a Japanese draft is found on its own line", () => {
  expect(chineseLines(japanese)).toEqual([]);
  expect(chineseLines(`${japanese}\n\n中文意思：好的，我会参加明天的会议。`)).toEqual(["中文意思：好的，我会参加明天的会议。"]);
  expect(chineseLines(`${japanese}\n(Meaning: I will attend.)`)).toEqual([]);
});

test("a Chinese-only reply is one Chinese line", () => {
  expect(singleChineseLine("我会参加明天的会议。")).toBe(true);
  expect(singleChineseLine("我会参加明天的会议。\n中文意思：我会参加明天的会议。")).toBe(false);
  expect(singleChineseLine("我会参加明天的会议。(I will attend)")).toBe(false);
  expect(singleChineseLine(japanese)).toBe(false);
});

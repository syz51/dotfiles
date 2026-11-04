// Deterministic language checks for replies: Japanese has kana, a Chinese line has Han
// characters and no kana.
const KANA = /[぀-ゟ゠-ヿ]/u;
const HAN = /\p{Script=Han}/gu;

export const hasKana = (text) => KANA.test(text);
export const hanCount = (text) => text.match(HAN)?.length ?? 0;

const lines = (text) => text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

// Lines written in Chinese: at least minHan Han characters and no kana.
export const chineseLines = (text, minHan = 4) => lines(text).filter((line) => !hasKana(line) && hanCount(line) >= minHan);

// A reply that is a single Chinese line: no kana and no Latin words.
export function singleChineseLine(text) {
  const all = lines(text);
  return all.length === 1 && !hasKana(all[0]) && hanCount(all[0]) >= 2 && !/[A-Za-z]{2,}/.test(all[0]);
}

const WAKE_WORD = String.raw`(?<![\p{L}\p{N}_])ол(?:[её]га?|ьга)(?![\p{L}\p{N}_])`;
const WAKE_WORD_PATTERN = new RegExp(WAKE_WORD, "iu");
const STOP_COMMAND_PATTERN = new RegExp(`${WAKE_WORD}[\\s,!.:;—-]*(?:стой|остановись|хватит)(?![\\p{L}\\p{N}_])`, "iu");

export function hasWakeWord(text: string): boolean {
  return WAKE_WORD_PATTERN.test(text);
}

export function hasStopCommand(text: string): boolean {
  return STOP_COMMAND_PATTERN.test(text);
}

export function isFillerOnlyTranscript(text: string): boolean {
  const fillers = new Set(["yeah", "yep", "uh", "um", "okay", "ok", "mm-hmm", "mhm", "mm", "hmm"]);
  const words = text.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) ?? [];
  return words.length > 0 && words.every((word) => fillers.has(word));
}

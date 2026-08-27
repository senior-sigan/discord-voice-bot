function wakeWordPattern(wakeWords: readonly string[]): string {
  const alternatives = wakeWords.map((word) => word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|");
  return String.raw`(?<![\p{L}\p{N}_])(?:${alternatives})(?![\p{L}\p{N}_])`;
}

export function hasWakeWord(text: string, wakeWords: readonly string[]): boolean {
  return new RegExp(wakeWordPattern(wakeWords), "iu").test(text);
}

export function hasStopCommand(text: string, wakeWords: readonly string[]): boolean {
  const pattern = `${wakeWordPattern(wakeWords)}[\\s,!.:;—-]*(?:стоп|стой|остановись|хватит)(?![\\p{L}\\p{N}_])`;
  return new RegExp(pattern, "iu").test(text);
}

export function isFillerOnlyTranscript(text: string): boolean {
  const fillers = new Set(["yeah", "yep", "uh", "um", "okay", "ok", "mm-hmm", "mhm", "mm", "hmm"]);
  const words = text.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) ?? [];
  return words.length > 0 && words.every((word) => fillers.has(word));
}

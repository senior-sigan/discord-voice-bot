export function hasWakeWord(text: string): boolean {
  return /(?<![\p{L}\p{N}_])ол[её]г(?![\p{L}\p{N}_])/iu.test(text);
}

export function hasStopCommand(text: string): boolean {
  return /(?<![\p{L}\p{N}_])ол[её]г(?![\p{L}\p{N}_])[\s,!.:;—-]*(?:стой|остановись|хватит)(?![\p{L}\p{N}_])/iu.test(
    text,
  );
}

export function isFillerOnlyTranscript(text: string): boolean {
  const fillers = new Set(["yeah", "yep", "uh", "um", "okay", "ok", "mm-hmm", "mhm", "mm", "hmm"]);
  const words = text.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) ?? [];
  return words.length > 0 && words.every((word) => fillers.has(word));
}

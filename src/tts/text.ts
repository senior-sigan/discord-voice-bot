export function spokenText(text: string): string {
  const result = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[*_`#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!result) throw new Error("Nothing to synthesize");
  return result;
}

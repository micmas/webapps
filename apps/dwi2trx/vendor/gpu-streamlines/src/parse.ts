/** Parse whitespace-separated numeric values from a text file. */
export function parseNumbers(text: string): number[] {
  return text
    .trim()
    .split(/\s+/)
    .filter((s) => s.length > 0)
    .map(Number)
}

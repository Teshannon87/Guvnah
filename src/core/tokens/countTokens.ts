import { Tiktoken, getEncoding } from "js-tiktoken";

let _enc: Tiktoken | null = null;

function enc(): Tiktoken {
  if (_enc) return _enc;
  _enc = getEncoding("cl100k_base");
  return _enc;
}

export function countTokens(text: string): number {
  if (!text) return 0;
  try {
    return enc().encode(text).length;
  } catch {
    // Fallback heuristic if the encoder errors on weird input.
    return Math.ceil(text.length / 4);
  }
}

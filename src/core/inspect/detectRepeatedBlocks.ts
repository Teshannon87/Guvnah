import type { RepeatedBlock } from "../../types/index.js";
import type { GuvnahConfig } from "../config/schema.js";
import { shortHash } from "../logging/hash.js";
import { countTokens } from "../tokens/countTokens.js";

export interface BlockOccurrenceInput {
  texts: string[];
}

interface BlockBucket {
  hash: string;
  preview: string;
  occurrences: number;
  tokens: number;
}

function splitBlocks(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
}

export function detectRepeatedBlocks(
  texts: string[],
  cfg: GuvnahConfig["detection"],
  priorOccurrences: (blockHash: string) => number = () => 0,
): RepeatedBlock[] {
  const buckets = new Map<string, BlockBucket>();

  for (const text of texts) {
    for (const block of splitBlocks(text)) {
      const tokens = countTokens(block);
      if (tokens < cfg.repeated_block_min_tokens) continue;
      const hash = shortHash(block);
      const bucket = buckets.get(hash);
      if (bucket) {
        bucket.occurrences += 1;
      } else {
        buckets.set(hash, {
          hash,
          preview: block.slice(0, 200),
          occurrences: 1,
          tokens,
        });
      }
    }
  }

  const out: RepeatedBlock[] = [];
  for (const bucket of buckets.values()) {
    const totalOccurrences = bucket.occurrences + priorOccurrences(bucket.hash);
    if (totalOccurrences >= cfg.repeated_block_min_occurrences) {
      out.push({
        block_hash: bucket.hash,
        occurrences: totalOccurrences,
        estimated_tokens: bucket.tokens,
        sample_preview: bucket.preview,
      });
    }
  }
  out.sort(
    (a, b) =>
      b.occurrences * b.estimated_tokens - a.occurrences * a.estimated_tokens,
  );
  return out;
}

/**
 * Incrementally parses a GeneratedSheet from a token stream.
 *
 * Call `feed(token)` for every new token as it arrives from the SSE stream.
 * Each call returns a partial GeneratedSheet — only the fields that are
 * fully complete at that point are present. Fields still in-flight are absent.
 *
 * The caller should shallow-diff the returned object against the previous one
 * to know which sections just completed, and update React state accordingly.
 */

import type { GeneratedSheet } from "@/types/generated-sheet";

// The fields we want to expose as soon as they complete, in stream order.
// Each entry: [jsonKey, outputKey]
const STRING_FIELDS: Array<[string, keyof GeneratedSheet]> = [
  ["topicEmoji", "topicEmoji"],
  ["topic",      "topic"],
  ["overview",   "overview"],
  ["clinicalApproach", "clinicalApproach"],
  ["referenceNote",    "referenceNote"],
];

const ARRAY_FIELDS: Array<[string, keyof GeneratedSheet]> = [
  ["memoryHooks",  "memoryHooks"],
  ["keyPoints",    "keyPoints"],
  ["examTraps",    "examTraps"],
  ["flashcards",   "flashcards"],
];

export type PartialSheet = Partial<GeneratedSheet>;

export function createStreamSheetParser() {
  let buffer = "";
  let partial: PartialSheet = {};

  /**
   * Feed one token. Returns the updated partial sheet.
   * The returned object is a new reference only when something changed.
   */
  function feed(token: string): PartialSheet {
    buffer += token;

    // Try to extract fields that haven't been parsed yet.
    let changed = false;

    for (const [jsonKey, outKey] of STRING_FIELDS) {
      if (outKey in partial) continue; // already extracted
      const extracted = extractStringField(buffer, jsonKey);
      if (extracted !== null) {
        (partial as Record<string, unknown>)[outKey as string] = extracted;
        changed = true;
      }
    }

    for (const [jsonKey, outKey] of ARRAY_FIELDS) {
      if (outKey in partial) continue;
      const extracted = extractArrayField(buffer, jsonKey);
      if (extracted !== null) {
        (partial as Record<string, unknown>)[outKey as string] = extracted;
        changed = true;
      }
    }

    return changed ? { ...partial } : partial;
  }

  function reset() {
    buffer = "";
    partial = {};
  }

  return { feed, reset };
}

// ── Field extractors ────────────────────────────────────────────────────────

/**
 * Extracts a completed JSON string value for the given key from the buffer.
 * Returns null if the field isn't complete yet.
 *
 * Handles:
 *  - Escaped quotes inside the value (\" does not close the string)
 *  - Escaped backslashes (\\ before a quote means the quote is literal)
 */
function extractStringField(buf: string, key: string): string | null {
  // Find   "key":   (with optional whitespace)
  const keyPattern = `"${key}"`;
  const keyIdx = buf.indexOf(keyPattern);
  if (keyIdx === -1) return null;

  // Find the opening quote of the value
  let i = keyIdx + keyPattern.length;
  while (i < buf.length && (buf[i] === " " || buf[i] === "\t" || buf[i] === "\n" || buf[i] === "\r" || buf[i] === ":")) {
    i++;
  }
  if (i >= buf.length || buf[i] !== '"') return null;
  i++; // skip opening quote

  // Walk to the closing quote, respecting escapes
  let value = "";
  while (i < buf.length) {
    const ch = buf[i];
    if (ch === "\\") {
      if (i + 1 >= buf.length) return null; // escape not yet received
      const next = buf[i + 1];
      if (next === "n")       { value += "\n"; i += 2; }
      else if (next === "t")  { value += "\t"; i += 2; }
      else if (next === "r")  { value += "\r"; i += 2; }
      else if (next === '"')  { value += '"';  i += 2; }
      else if (next === "\\") { value += "\\"; i += 2; }
      else                    { value += next; i += 2; }
    } else if (ch === '"') {
      // Closing quote — field is complete
      return value;
    } else {
      value += ch;
      i++;
    }
  }
  return null; // closing quote not yet received
}

/**
 * Extracts a completed JSON array for the given key from the buffer.
 * Returns the parsed array, or null if the array isn't closed yet.
 *
 * Uses bracket-counting so nested structures work (e.g. flashcards array
 * contains objects).
 */
function extractArrayField(buf: string, key: string): unknown[] | null {
  const keyPattern = `"${key}"`;
  const keyIdx = buf.indexOf(keyPattern);
  if (keyIdx === -1) return null;

  // Find the opening [
  let i = keyIdx + keyPattern.length;
  while (i < buf.length && buf[i] !== "[") i++;
  if (i >= buf.length) return null;

  // Walk the buffer counting brackets, respecting strings
  const start = i;
  let depth = 0;
  let inString = false;

  while (i < buf.length) {
    const ch = buf[i];
    if (inString) {
      if (ch === "\\" && i + 1 < buf.length) {
        i += 2; // skip escaped char
        continue;
      }
      if (ch === '"') inString = false;
    } else {
      if (ch === '"') inString = true;
      else if (ch === "[") depth++;
      else if (ch === "]") {
        depth--;
        if (depth === 0) {
          // Found the closing bracket — try to parse
          const raw = buf.slice(start, i + 1);
          try {
            return JSON.parse(raw) as unknown[];
          } catch {
            return null;
          }
        }
      }
    }
    i++;
  }
  return null; // array not closed yet
}

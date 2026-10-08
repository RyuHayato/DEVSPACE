/**
 * Fuzzy matching for the command palette.
 *
 * Plain subsequence matching ranks badly for the things a developer types:
 * `zar` should find "ZARChat" ahead of "Lazarus", and `npmd` should find
 * "npm run dev". So matches are scored, with bonuses for hits at word
 * boundaries and for runs of adjacent characters.
 */

export interface FuzzyMatch {
  score: number;
  /** Indices in the haystack that matched, for highlighting. */
  indices: number[];
}

const SEPARATORS = new Set([' ', '-', '_', '/', '\\', '.', ':', '·', '>']);

/** How many starting positions to try. Bounds the cost on long strings. */
const MAX_STARTS = 12;

const BONUS_FIRST_CHAR = 18;
const BONUS_BOUNDARY = 12;
const BONUS_CAMEL = 8;
const BONUS_ADJACENT = 10;
const BONUS_EXACT_SUBSTRING = 24;
const PENALTY_GAP = 2;
const PENALTY_MAX_GAP = 12;

function isBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  const previous = text[index - 1];
  return previous !== undefined && SEPARATORS.has(previous);
}

function isCamelBoundary(text: string, index: number): boolean {
  const previous = text[index - 1];
  const current = text[index];
  if (previous === undefined || current === undefined) return false;
  return previous === previous.toLowerCase() && current !== current.toLowerCase();
}

/**
 * Scores `query` against `text`. Returns null when the query is not a
 * subsequence of the text. An empty query matches everything with score 0.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return { score: 0, indices: [] };
  if (!text) return null;

  const haystack = text.toLowerCase();
  if (needle.length > haystack.length) return null;

  let best: FuzzyMatch | null = null;
  let starts = 0;

  for (let start = 0; start < haystack.length && starts < MAX_STARTS; start += 1) {
    if (haystack[start] !== needle[0]) continue;
    starts += 1;
    const candidate = scoreFrom(needle, text, haystack, start);
    if (candidate && (!best || candidate.score > best.score)) best = candidate;
  }

  if (best && haystack.includes(needle)) {
    best = { ...best, score: best.score + BONUS_EXACT_SUBSTRING };
  }
  return best;
}

function scoreFrom(
  needle: string,
  original: string,
  haystack: string,
  start: number,
): FuzzyMatch | null {
  const indices: number[] = [];
  let score = 0;
  let cursor = start;

  for (let n = 0; n < needle.length; n += 1) {
    const target = needle[n];
    let found = -1;
    for (let i = cursor; i < haystack.length; i += 1) {
      if (haystack[i] === target) {
        found = i;
        break;
      }
    }
    if (found === -1) return null;

    const previousIndex = indices[indices.length - 1];
    const gap = previousIndex === undefined ? found - start : found - previousIndex - 1;

    score += 1;
    if (found === 0) score += BONUS_FIRST_CHAR;
    else if (isBoundary(original, found)) score += BONUS_BOUNDARY;
    else if (isCamelBoundary(original, found)) score += BONUS_CAMEL;

    if (previousIndex !== undefined && gap === 0) score += BONUS_ADJACENT;
    if (gap > 0) score -= Math.min(gap * PENALTY_GAP, PENALTY_MAX_GAP);

    indices.push(found);
    cursor = found + 1;
  }

  // Matching early in a short string beats matching late in a long one.
  score -= Math.min(start, 10);
  score -= Math.min(Math.floor(haystack.length / 24), 6);
  return { score, indices };
}

export interface Ranked<T> {
  item: T;
  score: number;
  indices: number[];
}

/**
 * Ranks items by their best-matching field. Earlier fields win ties, so a
 * caller can pass `[title, subtitle]` and have title matches surface first.
 */
export function rankItems<T>(
  query: string,
  items: readonly T[],
  fields: (item: T) => readonly string[],
): Ranked<T>[] {
  const ranked: Ranked<T>[] = [];

  for (const item of items) {
    const candidates = fields(item);
    let best: { score: number; indices: number[] } | null = null;

    for (let f = 0; f < candidates.length; f += 1) {
      const value = candidates[f];
      if (!value) continue;
      const match = fuzzyMatch(query, value);
      if (!match) continue;
      // Later fields are worth slightly less than earlier ones.
      const adjusted = { score: match.score - f * 6, indices: f === 0 ? match.indices : [] };
      if (!best || adjusted.score > best.score) best = adjusted;
    }

    if (best) ranked.push({ item, score: best.score, indices: best.indices });
  }

  return ranked.sort((a, b) => b.score - a.score);
}

export interface HighlightSegment {
  text: string;
  match: boolean;
}

/** Splits `text` into alternating plain and matched segments. */
export function highlight(text: string, indices: readonly number[]): HighlightSegment[] {
  if (indices.length === 0) return text ? [{ text, match: false }] : [];

  const flags = new Set(indices);
  const segments: HighlightSegment[] = [];
  let buffer = '';
  let bufferMatch = flags.has(0);

  for (let i = 0; i < text.length; i += 1) {
    const isMatch = flags.has(i);
    if (isMatch !== bufferMatch) {
      if (buffer) segments.push({ text: buffer, match: bufferMatch });
      buffer = '';
      bufferMatch = isMatch;
    }
    buffer += text[i];
  }
  if (buffer) segments.push({ text: buffer, match: bufferMatch });
  return segments;
}

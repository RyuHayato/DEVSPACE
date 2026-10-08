import { describe, expect, it } from 'vitest';
import { fuzzyMatch, highlight, rankItems } from './fuzzy';

describe('fuzzyMatch', () => {
  it('matches a subsequence and reports where it hit', () => {
    const match = fuzzyMatch('npmd', 'npm run dev');
    expect(match).not.toBeNull();
    expect(match?.indices).toEqual([0, 1, 2, 8]);
  });

  it('rejects a query that is not a subsequence', () => {
    expect(fuzzyMatch('xyz', 'npm run dev')).toBeNull();
  });

  it('rejects a query longer than the text', () => {
    expect(fuzzyMatch('npm run dev --watch', 'npm')).toBeNull();
  });

  it('treats an empty query as matching everything, with no highlight', () => {
    expect(fuzzyMatch('', 'anything')).toEqual({ score: 0, indices: [] });
    expect(fuzzyMatch('   ', 'anything')).toEqual({ score: 0, indices: [] });
  });

  it('finds nothing in empty text', () => {
    expect(fuzzyMatch('a', '')).toBeNull();
  });

  it('is case insensitive', () => {
    expect(fuzzyMatch('ZAR', 'zarchat')).not.toBeNull();
    expect(fuzzyMatch('zar', 'ZARChat')).not.toBeNull();
  });

  it('prefers a prefix match over the same letters buried mid-word', () => {
    const prefix = fuzzyMatch('zar', 'ZARChat');
    const buried = fuzzyMatch('zar', 'Lazarus');
    expect(prefix!.score).toBeGreaterThan(buried!.score);
  });

  it('rewards adjacent characters over scattered ones', () => {
    const adjacent = fuzzyMatch('test', 'test runner');
    const scattered = fuzzyMatch('test', 'the easiest thing');
    expect(adjacent!.score).toBeGreaterThan(scattered!.score);
  });

  it('rewards a hit after a separator', () => {
    const boundary = fuzzyMatch('d', 'npm run dev');
    const mid = fuzzyMatch('d', 'wedge');
    expect(boundary!.score).toBeGreaterThan(mid!.score);
  });

  it('rewards a camelCase boundary', () => {
    const camel = fuzzyMatch('c', 'zarChat');
    const plain = fuzzyMatch('c', 'zarchat');
    expect(camel!.score).toBeGreaterThan(plain!.score);
  });
});

describe('rankItems', () => {
  const items = [
    { title: 'ZARChat', subtitle: 'C:\\code\\zarchat' },
    { title: 'LUMEN', subtitle: 'C:\\code\\lumen' },
    { title: 'Atlas API', subtitle: 'C:\\code\\atlas-api' },
  ];
  const fields = (item: (typeof items)[number]) => [item.title, item.subtitle];

  it('orders by score, best first', () => {
    const ranked = rankItems('zar', items, fields);
    expect(ranked[0]?.item.title).toBe('ZARChat');
  });

  it('drops items that do not match at all', () => {
    expect(rankItems('qqqq', items, fields)).toHaveLength(0);
  });

  it('returns everything for an empty query', () => {
    expect(rankItems('', items, fields)).toHaveLength(3);
  });

  it('still matches on a later field but does not highlight it', () => {
    // "code" appears only in the paths, never in a title.
    const ranked = rankItems('code', items, fields);
    expect(ranked).toHaveLength(3);
    expect(ranked.every((entry) => entry.indices.length === 0)).toBe(true);
  });

  it('prefers a title match over a subtitle match', () => {
    const ranked = rankItems('lumen', items, fields);
    expect(ranked[0]?.item.title).toBe('LUMEN');
    expect(ranked[0]?.indices.length).toBeGreaterThan(0);
  });

  it('ignores empty fields rather than scoring them', () => {
    const ranked = rankItems('a', [{ title: '', subtitle: 'alpha' }], (item) => [
      item.title,
      item.subtitle,
    ]);
    expect(ranked).toHaveLength(1);
  });
});

describe('highlight', () => {
  it('splits text into matched and unmatched runs', () => {
    expect(highlight('npm run dev', [0, 1, 2])).toEqual([
      { text: 'npm', match: true },
      { text: ' run dev', match: false },
    ]);
  });

  it('handles a match that is not at the start', () => {
    expect(highlight('abcd', [2])).toEqual([
      { text: 'ab', match: false },
      { text: 'c', match: true },
      { text: 'd', match: false },
    ]);
  });

  it('returns one plain segment when nothing matched', () => {
    expect(highlight('abcd', [])).toEqual([{ text: 'abcd', match: false }]);
  });

  it('returns nothing for empty text', () => {
    expect(highlight('', [])).toEqual([]);
  });

  it('reassembles into the original string', () => {
    const segments = highlight('npm run dev', [0, 4, 8]);
    expect(segments.map((segment) => segment.text).join('')).toBe('npm run dev');
  });
});

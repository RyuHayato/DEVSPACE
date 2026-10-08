import { describe, expect, it } from 'vitest';
import {
  clockTime,
  ecosystemLabel,
  formatBytes,
  formatDuration,
  modifierKey,
  pluralize,
  relativeTime,
  shortenPath,
  singleLine,
} from './format';

describe('formatDuration', () => {
  it('uses milliseconds below a second', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(420)).toBe('420ms');
    expect(formatDuration(999)).toBe('999ms');
  });

  it('uses one decimal of seconds below a minute', () => {
    expect(formatDuration(1000)).toBe('1.0s');
    expect(formatDuration(2449)).toBe('2.4s');
  });

  it('uses minutes and zero-padded seconds below an hour', () => {
    expect(formatDuration(65_000)).toBe('1m 05s');
    expect(formatDuration(3_599_000)).toBe('59m 59s');
  });

  it('uses hours and zero-padded minutes beyond that', () => {
    expect(formatDuration(3_600_000)).toBe('1h 00m');
    expect(formatDuration(3_600_000 + 4 * 60_000)).toBe('1h 04m');
  });

  it('refuses nonsense rather than printing it', () => {
    expect(formatDuration(-1)).toBe('—');
    expect(formatDuration(Number.NaN)).toBe('—');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('relativeTime', () => {
  const now = 1_700_000_000_000;

  it('calls anything recent "just now"', () => {
    expect(relativeTime(now, now)).toBe('just now');
    expect(relativeTime(now - 44_000, now)).toBe('just now');
  });

  it('never reports a future time as elapsed', () => {
    expect(relativeTime(now + 60_000, now)).toBe('just now');
  });

  it('counts minutes, then hours', () => {
    expect(relativeTime(now - 4 * 60_000, now)).toBe('4m ago');
    expect(relativeTime(now - 59 * 60_000, now)).toBe('59m ago');
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(relativeTime(now - 23 * 3_600_000, now)).toBe('23h ago');
  });

  it('names yesterday, then counts days up to a week', () => {
    expect(relativeTime(now - 86_400_000, now)).toBe('yesterday');
    expect(relativeTime(now - 3 * 86_400_000, now)).toBe('3d ago');
  });

  it('falls back to a date beyond a week', () => {
    const older = relativeTime(now - 40 * 86_400_000, now);
    expect(older).not.toMatch(/ago|yesterday|just now/);
  });
});

describe('clockTime', () => {
  it('zero-pads to a fixed width so lines align', () => {
    const at = new Date(2026, 0, 2, 9, 5, 3).getTime();
    expect(clockTime(at)).toBe('09:05:03');
  });
});

describe('formatBytes', () => {
  it('scales through bytes, kilobytes and megabytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(1536 * 1024)).toBe('1.5 MB');
  });

  it('refuses nonsense', () => {
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
  });
});

describe('shortenPath', () => {
  it('keeps the separator style of the original', () => {
    expect(shortenPath('C:\\Users\\dev\\code\\zarchat', 2)).toBe('…\\code\\zarchat');
    expect(shortenPath('/Users/dev/code/zarchat', 2)).toBe('…/code/zarchat');
  });

  it('leaves a path that is already short enough alone', () => {
    expect(shortenPath('code/zarchat', 2)).toBe('code/zarchat');
    expect(shortenPath('zarchat', 2)).toBe('zarchat');
  });

  it('honours the segment count', () => {
    expect(shortenPath('/a/b/c/d/e', 3)).toBe('…/c/d/e');
  });

  it('returns an empty string for empty input', () => {
    expect(shortenPath('')).toBe('');
  });
});

describe('pluralize', () => {
  it('uses the singular only for exactly one', () => {
    expect(pluralize(1, 'file')).toBe('1 file');
    expect(pluralize(0, 'file')).toBe('0 files');
    expect(pluralize(7, 'file')).toBe('7 files');
  });

  it('accepts an irregular plural', () => {
    expect(pluralize(2, 'entry', 'entries')).toBe('2 entries');
  });
});

describe('singleLine', () => {
  it('collapses whitespace onto one line', () => {
    expect(singleLine('npm  run\n  dev')).toBe('npm run dev');
  });

  it('truncates with an ellipsis at the limit', () => {
    expect(singleLine('abcdefghij', 5)).toBe('abcd…');
  });

  it('leaves a short value untouched', () => {
    expect(singleLine('npm test', 20)).toBe('npm test');
  });
});

describe('modifierKey', () => {
  it('reports the platform modifier', () => {
    expect(modifierKey('MacIntel')).toBe('⌘');
    expect(modifierKey('iPhone')).toBe('⌘');
    expect(modifierKey('Win32')).toBe('Ctrl');
    expect(modifierKey('Linux x86_64')).toBe('Ctrl');
    expect(modifierKey('')).toBe('Ctrl');
  });
});

describe('ecosystemLabel', () => {
  it('maps known ids to display names', () => {
    expect(ecosystemLabel('node')).toBe('Node');
    expect(ecosystemLabel('jvm')).toBe('JVM');
  });

  it('passes an unknown id through rather than hiding it', () => {
    expect(ecosystemLabel('zig')).toBe('zig');
  });
});

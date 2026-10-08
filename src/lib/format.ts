/**
 * Formatting helpers. All pure, all given an explicit `now` where time is
 * involved so the UI stays testable and never drifts between renders.
 */

/** `420ms`, `2.4s`, `1m 05s`, `1h 04m`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;

  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;

  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** `just now`, `4m ago`, `3h ago`, `yesterday`, `12 Mar`. */
export function relativeTime(at: number, now: number = Date.now()): string {
  const diff = now - at;
  if (!Number.isFinite(diff)) return '—';
  if (diff < 0) return 'just now';
  if (diff < 45_000) return 'just now';

  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(diff / 3_600_000);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(diff / 86_400_000);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;

  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** `14:03:22`, for terminal timestamps. */
export function clockTime(at: number): string {
  const date = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Shortens a path to its last `segments` parts, keeping the separator style
 * of the original so a Windows path still looks like one.
 */
export function shortenPath(path: string, segments = 2): string {
  if (!path) return '';
  const separator = path.includes('\\') ? '\\' : '/';
  const parts = path.split(/[/\\]/).filter(Boolean);
  if (parts.length <= segments) return path;
  return `…${separator}${parts.slice(-segments).join(separator)}`;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Collapses whitespace so a command fits on one line in a list. */
export function singleLine(value: string, max = 120): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** `Ctrl` on Windows and Linux, `⌘` on macOS. */
export function modifierKey(platform: string = navigator.platform ?? ''): string {
  return /mac|iphone|ipad/i.test(platform) ? '⌘' : 'Ctrl';
}

/** Human label for a detected ecosystem id. */
export function ecosystemLabel(id: string): string {
  const labels: Record<string, string> = {
    node: 'Node',
    deno: 'Deno',
    rust: 'Rust',
    python: 'Python',
    go: 'Go',
    jvm: 'JVM',
    ruby: 'Ruby',
    php: 'PHP',
    make: 'Make',
    docker: 'Docker',
  };
  return labels[id] ?? id;
}

/**
 * The output panel: a real log of real process output.
 *
 * Nothing here is simulated. Lines arrive as batched events from the running
 * process and are appended verbatim. The panel follows the tail until the
 * user scrolls up, at which point it stops and offers to resume — the
 * behaviour a developer expects from a terminal.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ChevronDown, ChevronUp, Copy, Eraser, Square } from 'lucide-react';
import { clockTime, formatDuration } from '@/lib/format';
import type { RunMeta, RunStatus } from '@/lib/types';
import { useAppStore } from '@/state/store';
import { Badge, Button } from './ui';

const MIN_HEIGHT = 140;
const MAX_FRACTION = 0.75;
const DEFAULT_HEIGHT = 300;
/** Distance from the bottom still treated as "following the tail". */
const FOLLOW_THRESHOLD = 24;

const STATUS_TONE: Record<RunStatus, 'accent' | 'success' | 'danger' | 'warning'> = {
  running: 'accent',
  succeeded: 'success',
  failed: 'danger',
  error: 'danger',
  cancelled: 'warning',
};

const STATUS_LABEL: Record<RunStatus, string> = {
  running: 'running',
  succeeded: 'passed',
  failed: 'failed',
  error: 'error',
  cancelled: 'stopped',
};

const DOT_CLASS: Record<RunStatus, string> = {
  running: 'dot--running',
  succeeded: 'dot--clean',
  failed: 'dot--dirty',
  error: 'dot--dirty',
  cancelled: 'dot--none',
};

function RunSummary({ run }: { run: RunMeta }) {
  const [, forceTick] = useState(0);
  const live = run.status === 'running';

  // The elapsed time of a live run needs its own tick; everything else in
  // this panel is event-driven.
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [live]);

  const elapsed = (run.finishedAt ?? Date.now()) - run.startedAt;

  return (
    <span className="output__status">
      <Badge tone={STATUS_TONE[run.status]}>{STATUS_LABEL[run.status]}</Badge>
      <span className="truncate" title={run.command}>
        {run.command}
      </span>
      <span aria-hidden>·</span>
      <span>{formatDuration(elapsed)}</span>
      {run.exitCode !== null && run.status !== 'succeeded' ? (
        <>
          <span aria-hidden>·</span>
          <span>exit {run.exitCode}</span>
        </>
      ) : null}
    </span>
  );
}

export function OutputPanel({ projectId }: { projectId: string | null }) {
  const runs = useAppStore((s) => s.runs);
  const output = useAppStore((s) => s.output);
  const focusedRunId = useAppStore((s) => s.focusedRunId);
  const focusRun = useAppStore((s) => s.focusRun);
  const cancelRun = useAppStore((s) => s.cancelRun);
  const clearOutput = useAppStore((s) => s.clearOutput);
  const toast = useAppStore((s) => s.toast);
  const showTimestamps = useAppStore((s) => s.workspace.settings.showTimestamps);
  const autoScroll = useAppStore((s) => s.workspace.settings.autoScrollOutput);
  const fontSize = useAppStore((s) => s.workspace.settings.terminalFontSize);

  const [collapsed, setCollapsed] = useState(false);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [dragging, setDragging] = useState(false);
  const [following, setFollowing] = useState(true);

  const scrollerRef = useRef<HTMLDivElement>(null);

  const projectRuns = Object.values(runs)
    .filter((run): run is RunMeta => !!run && (!projectId || run.projectId === projectId))
    .sort((a, b) => a.startedAt - b.startedAt);

  const current =
    projectRuns.find((run) => run.runId === focusedRunId) ??
    projectRuns[projectRuns.length - 1] ??
    null;
  const lines = current ? (output[current.runId] ?? []) : [];

  // --- following the tail ----------------------------------------------

  const atBottom = useCallback(() => {
    const node = scrollerRef.current;
    if (!node) return true;
    return node.scrollHeight - node.scrollTop - node.clientHeight <= FOLLOW_THRESHOLD;
  }, []);

  const onScroll = useCallback(() => {
    setFollowing(atBottom());
  }, [atBottom]);

  // Layout effect so the jump happens in the same frame as the new lines.
  useLayoutEffect(() => {
    if (!autoScroll || !following || collapsed) return;
    const node = scrollerRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [lines.length, autoScroll, following, collapsed, current?.runId]);

  // Switching runs always starts at the tail.
  useEffect(() => {
    setFollowing(true);
  }, [current?.runId]);

  // --- resizing ----------------------------------------------------------

  const startResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (collapsed) return;
      event.preventDefault();
      const startY = event.clientY;
      const startHeight = height;
      setDragging(true);

      const onMove = (move: PointerEvent) => {
        const max = Math.max(MIN_HEIGHT, window.innerHeight * MAX_FRACTION);
        setHeight(Math.min(max, Math.max(MIN_HEIGHT, startHeight - (move.clientY - startY))));
      };
      const onUp = () => {
        setDragging(false);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [collapsed, height],
  );

  // Keyboard resizing, so the splitter is not pointer-only.
  const onResizerKeyDown = useCallback((event: React.KeyboardEvent) => {
    const step = event.shiftKey ? 48 : 16;
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHeight((h) => Math.min(window.innerHeight * MAX_FRACTION, h + step));
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHeight((h) => Math.max(MIN_HEIGHT, h - step));
    }
  }, []);

  // --- actions ------------------------------------------------------------

  async function copyAll() {
    if (!current || lines.length === 0) return;
    const text = lines.map((line) => line.text).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toast({ level: 'success', title: 'Output copied' });
    } catch {
      toast({
        level: 'error',
        title: 'Could not copy the output',
        hint: 'Your system denied clipboard access. Select the text and copy it manually.',
      });
    }
  }

  const title = current ? `${current.label} · ${current.projectName}` : 'Output';

  return (
    <section
      className={`output${collapsed ? ' output--collapsed' : ''}`}
      style={
        collapsed
          ? undefined
          : ({
              '--output-h': `${height}px`,
              '--terminal-size': `${fontSize}px`,
            } as React.CSSProperties)
      }
      aria-label="Command output"
    >
      {!collapsed ? (
        <div
          className="output__resizer"
          data-dragging={dragging}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize output panel"
          aria-valuenow={Math.round(height)}
          aria-valuemin={MIN_HEIGHT}
          tabIndex={0}
          onPointerDown={startResize}
          onKeyDown={onResizerKeyDown}
        />
      ) : null}

      <div className="output__bar">
        <div className="output__title">
          <h2 className="t-eyebrow">Output</h2>
        </div>

        {projectRuns.length > 1 ? (
          <div className="run-tabs" role="tablist" aria-label="Command runs">
            {projectRuns.map((run) => (
              <button
                key={run.runId}
                type="button"
                role="tab"
                className="run-tab"
                aria-selected={run.runId === current?.runId}
                onClick={() => focusRun(run.runId)}
              >
                <span className={`dot ${DOT_CLASS[run.status]}`} aria-hidden />
                {run.label}
              </button>
            ))}
          </div>
        ) : null}

        <div className="output__bar-actions">
          {current ? <RunSummary run={current} /> : null}

          {current?.status === 'running' ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void cancelRun(current.runId)}
              title="Stop this command"
            >
              <Square size={11} fill="currentColor" aria-hidden />
              Stop
            </Button>
          ) : null}

          <Button
            variant="ghost"
            icon
            size="sm"
            disabled={lines.length === 0}
            onClick={() => void copyAll()}
            aria-label="Copy output"
          >
            <Copy size={13} aria-hidden />
          </Button>
          <Button
            variant="ghost"
            icon
            size="sm"
            disabled={!current || lines.length === 0}
            onClick={() => current && clearOutput(current.runId)}
            aria-label="Clear output"
          >
            <Eraser size={13} aria-hidden />
          </Button>
          <Button
            variant="ghost"
            icon
            size="sm"
            onClick={() => setCollapsed((value) => !value)}
            aria-label={collapsed ? 'Expand output panel' : 'Collapse output panel'}
            aria-expanded={!collapsed}
          >
            {collapsed ? (
              <ChevronUp size={14} aria-hidden />
            ) : (
              <ChevronDown size={14} aria-hidden />
            )}
          </Button>
        </div>
      </div>

      {!collapsed ? (
        <div
          className="terminal"
          ref={scrollerRef}
          onScroll={onScroll}
          tabIndex={0}
          role="log"
          aria-live="off"
          aria-label={`Output of ${title}`}
        >
          {lines.length === 0 ? (
            <p className="t-meta" style={{ fontFamily: 'var(--font-ui)' }}>
              {current
                ? 'Waiting for output…'
                : 'Run a command to see its output here. Nothing is shown until a real process writes something.'}
            </p>
          ) : (
            lines.map((line) => (
              <div key={line.seq} className={`terminal__line terminal__line--${line.stream}`}>
                {showTimestamps ? (
                  <span className="terminal__time">{clockTime(line.at)}</span>
                ) : null}
                <span>{line.text || ' '}</span>
              </div>
            ))
          )}

          {!following && lines.length > 0 ? (
            <div className="terminal__follow">
              <Button
                size="sm"
                onClick={() => {
                  const node = scrollerRef.current;
                  if (node) node.scrollTop = node.scrollHeight;
                  setFollowing(true);
                }}
              >
                <ArrowDownToLine size={12} aria-hidden />
                Follow output
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

import { History, Trash2 } from 'lucide-react';
import { relativeTime } from '@/lib/format';
import { useAppStore } from '@/state/store';
import { Button, EmptyState } from './ui';

const MAX_ROWS = 12;

export function ActivityPanel({ projectId }: { projectId: string | null }) {
  const activity = useAppStore((s) => s.workspace.activity);
  const clearActivity = useAppStore((s) => s.clearActivity);

  // Entries for this project first, then everything else, so the panel is
  // useful without hiding what happened elsewhere.
  const rows = [...activity]
    .sort((a, b) => {
      const mine = Number(b.projectId === projectId) - Number(a.projectId === projectId);
      return mine !== 0 ? mine : b.at - a.at;
    })
    .slice(0, MAX_ROWS);

  return (
    <section className="panel" aria-labelledby="activity-heading">
      <header className="panel__head">
        <h2 className="t-eyebrow" id="activity-heading">
          Recent activity
        </h2>
        <div className="panel__head-actions">
          {activity.length > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void clearActivity()}
              aria-label="Clear activity and command history"
            >
              <Trash2 size={13} aria-hidden />
              Clear
            </Button>
          ) : null}
        </div>
      </header>

      <div className="panel__body">
        {rows.length === 0 ? (
          <EmptyState
            variant="inline"
            icon={History}
            title="Nothing has happened yet"
            body="Commands you run and projects you open are recorded here, and kept between sessions."
          />
        ) : (
          <ul className="activity-list">
            {rows.map((entry) => (
              <li key={entry.id} className={`activity-row activity-row--${entry.level}`}>
                <span className="activity-row__mark" aria-hidden />
                <span className="activity-row__text">
                  <span className="activity-row__title truncate">{entry.title}</span>
                  {entry.detail ? (
                    <span className="activity-row__detail truncate" title={entry.detail}>
                      {entry.detail}
                    </span>
                  ) : null}
                </span>
                <time
                  className="activity-row__time"
                  dateTime={new Date(entry.at).toISOString()}
                >
                  {relativeTime(entry.at)}
                </time>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

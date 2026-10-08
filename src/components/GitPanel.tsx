import { CircleSlash, GitBranch, RefreshCw } from 'lucide-react';
import { pluralize } from '@/lib/format';
import type { GitStatus, ProjectStatus } from '@/lib/types';
import { useAppStore } from '@/state/store';
import { Badge, Button, EmptyState, Notice, SkeletonStack } from './ui';

function changeTone(code: string) {
  if (code.startsWith('U') || code.endsWith('U')) return 'conflicted';
  if (code === '??') return 'untracked';
  if (code[0] !== '.' && code[0] !== '?') return 'staged';
  return 'unstaged';
}

function Counts({ git }: { git: GitStatus }) {
  const parts: Array<{ label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> =
    [];
  if (git.conflicted > 0) parts.push({ label: `${git.conflicted} conflicted`, tone: 'danger' });
  if (git.staged > 0) parts.push({ label: `${git.staged} staged`, tone: 'success' });
  if (git.unstaged > 0) parts.push({ label: `${git.unstaged} unstaged`, tone: 'warning' });
  if (git.untracked > 0) parts.push({ label: `${git.untracked} untracked`, tone: 'neutral' });

  return (
    <div style={{ display: 'flex', gap: 'var(--s-3)', flexWrap: 'wrap' }}>
      {parts.map((part) => (
        <Badge key={part.label} tone={part.tone}>
          {part.label}
        </Badge>
      ))}
    </div>
  );
}

export function GitPanel({
  status,
  loading,
  projectId,
}: {
  status: ProjectStatus | undefined;
  loading: boolean;
  projectId: string;
}) {
  const refreshStatus = useAppStore((s) => s.refreshStatus);
  const git = status?.git;

  return (
    <section className="panel" aria-labelledby="git-heading">
      <header className="panel__head">
        <h2 className="t-eyebrow" id="git-heading">
          Working tree
        </h2>
        {git?.isRepo && git.branch ? (
          <span className="branch">
            <GitBranch size={12} aria-hidden />
            <span className="branch__name">{git.branch}</span>
          </span>
        ) : null}
        <div className="panel__head-actions">
          <Button
            variant="ghost"
            icon
            size="sm"
            busy={loading}
            onClick={() => void refreshStatus(projectId, { force: true })}
            aria-label="Refresh Git status"
          >
            {loading ? null : <RefreshCw size={13} aria-hidden />}
          </Button>
        </div>
      </header>

      <div className="panel__body">
        {!status && loading ? <SkeletonStack rows={4} /> : null}

        {status && !status.exists ? (
          <Notice
            level="error"
            title={status.error?.message ?? 'This folder is unavailable.'}
            hint={status.error?.hint}
          />
        ) : null}

        {git && status?.exists && !git.available ? (
          <Notice
            level="warn"
            title="Git is not available."
            detail="DevWorkspace could not find `git` on your PATH."
            hint="Install Git, or reopen DevWorkspace after adding it to your PATH."
          />
        ) : null}

        {git && status?.exists && git.available && !git.isRepo ? (
          <EmptyState
            variant="inline"
            icon={CircleSlash}
            title="Not a Git repository"
            body="This folder is not version controlled, so there is nothing to compare."
          />
        ) : null}

        {git?.isRepo ? (
          <>
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 'var(--s-5)',
                alignItems: 'center',
                paddingBottom: git.clean ? 0 : 'var(--s-5)',
              }}
            >
              {git.clean ? (
                <span className="t-meta">
                  Working tree clean
                  {git.upstream ? ` · tracking ${git.upstream}` : ' · no upstream'}
                </span>
              ) : (
                <Counts git={git} />
              )}
            </div>

            {git.files.length > 0 ? (
              <>
                <ul className="file-list" aria-label="Changed files">
                  {git.files.map((file) => (
                    <li
                      key={`${file.code}-${file.path}`}
                      className={`file-row file-row--${changeTone(file.code)}`}
                    >
                      <span className="file-row__code" title={`Status ${file.code}`}>
                        {file.code.replace(/\./g, '·')}
                      </span>
                      <span className="file-row__path truncate" dir="ltr" title={file.path}>
                        {file.path}
                      </span>
                    </li>
                  ))}
                </ul>
                {git.truncated ? (
                  <p className="t-meta" style={{ paddingTop: 'var(--s-4)' }}>
                    Showing the first {git.files.length} of{' '}
                    {pluralize(git.totalChanged, 'change')}.
                  </p>
                ) : null}
              </>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}

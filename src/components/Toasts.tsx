/**
 * Transient notifications.
 *
 * Toasts report the outcome of something the user asked for, so they are
 * announced politely rather than interrupting, and anything that failed stays
 * on screen until it is dismissed — a developer needs time to read an error.
 */

import { useEffect } from 'react';
import { AlertTriangle, CheckCircle2, Info, OctagonAlert, X } from 'lucide-react';
import { useAppStore, type Toast, type ToastLevel } from '@/state/store';
import { Button } from './ui';

const ICONS: Record<ToastLevel, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  warn: AlertTriangle,
  error: OctagonAlert,
};

/** How long each level stays up. Errors never expire on their own. */
const LIFETIME_MS: Record<ToastLevel, number> = {
  info: 4_000,
  success: 4_000,
  warn: 7_000,
  error: 0,
};

function ToastRow({ toast }: { toast: Toast }) {
  const dismissToast = useAppStore((s) => s.dismissToast);
  const Icon = ICONS[toast.level];
  const lifetime = LIFETIME_MS[toast.level];

  useEffect(() => {
    if (lifetime === 0) return;
    const timer = window.setTimeout(() => dismissToast(toast.id), lifetime);
    return () => window.clearTimeout(timer);
  }, [toast.id, lifetime, dismissToast]);

  return (
    <div
      className={`toast toast--${toast.level}`}
      // An error interrupts; anything else waits its turn. Putting the role on
      // the row itself means the text exists once, not mirrored into a
      // separate live region where a screen reader would meet it twice.
      role={toast.level === 'error' ? 'alert' : 'status'}
    >
      <span className="toast__icon">
        <Icon size={15} aria-hidden />
      </span>
      <div className="toast__text">
        <span className="toast__title">{toast.title}</span>
        {toast.detail ? <span className="toast__detail">{toast.detail}</span> : null}
        {toast.hint ? <span className="toast__hint">{toast.hint}</span> : null}
      </div>
      <Button
        variant="ghost"
        icon
        size="sm"
        onClick={() => dismissToast(toast.id)}
        aria-label={`Dismiss: ${toast.title}`}
      >
        <X size={13} aria-hidden />
      </Button>
    </div>
  );
}

export function Toasts() {
  const toasts = useAppStore((s) => s.toasts);

  // The container stays mounted even when empty: a live region has to exist
  // before its content changes for the change to be announced reliably.
  return (
    <div className="toasts" role="region" aria-label="Notifications">
      {toasts.map((toast) => (
        <ToastRow key={toast.id} toast={toast} />
      ))}
    </div>
  );
}

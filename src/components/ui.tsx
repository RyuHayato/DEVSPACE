/**
 * UI primitives.
 *
 * Small, unopinionated wrappers over native elements. Everything that can be
 * a `<button>` is one, so keyboard and screen-reader behaviour comes for free
 * rather than being re-implemented.
 */

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import {
  AlertTriangle,
  Check,
  Info,
  Loader2,
  OctagonAlert,
  type LucideIcon,
} from 'lucide-react';

type ButtonVariant = 'default' | 'accent' | 'ghost' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'md' | 'sm';
  icon?: boolean;
  block?: boolean;
  busy?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', size = 'md', icon, block, busy, className, children, ...rest },
  ref,
) {
  const classes = [
    'btn',
    variant !== 'default' ? `btn--${variant}` : '',
    size === 'sm' ? 'btn--sm' : '',
    icon ? 'btn--icon' : '',
    block ? 'btn--block' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button ref={ref} type="button" className={classes} aria-busy={busy || undefined} {...rest}>
      {busy ? <Loader2 size={14} className="spinner" aria-hidden /> : null}
      {children}
    </button>
  );
});

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export function Badge({
  tone = 'neutral',
  children,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`badge${tone === 'neutral' ? '' : ` badge--${tone}`}`} title={title}>
      {children}
    </span>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <Loader2 size={size} className="spinner" aria-hidden />;
}

export function Skeleton({ width = '100%', height = 10 }: { width?: string; height?: number }) {
  return <div className="skeleton" style={{ width, height }} aria-hidden />;
}

/** Placeholder shown while a panel's data is still being read. */
export function SkeletonStack({ rows = 3 }: { rows?: number }) {
  return (
    <div className="skeleton-stack" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} width={`${100 - i * 14}%`} />
      ))}
    </div>
  );
}

const NOTICE_ICONS: Record<'info' | 'warn' | 'error', LucideIcon> = {
  info: Info,
  warn: AlertTriangle,
  error: OctagonAlert,
};

/**
 * An inline explanation of a problem: what failed, why where we know, and
 * what the user can do about it.
 */
export function Notice({
  level = 'info',
  title,
  detail,
  hint,
  actions,
}: {
  level?: 'info' | 'warn' | 'error';
  title: string;
  detail?: string;
  hint?: string;
  actions?: ReactNode;
}) {
  const Icon = NOTICE_ICONS[level];
  return (
    <div className={`notice notice--${level}`} role={level === 'error' ? 'alert' : 'status'}>
      <span className="notice__icon">
        <Icon size={15} aria-hidden />
      </span>
      <div className="notice__text">
        <span className="t-ui">{title}</span>
        {detail ? <span className="t-meta">{detail}</span> : null}
        {hint ? <span className="t-meta">{hint}</span> : null}
        {actions ? <div className="notice__actions">{actions}</div> : null}
      </div>
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  body,
  actions,
  variant = 'default',
}: {
  icon?: LucideIcon;
  title: string;
  body?: string;
  actions?: ReactNode;
  variant?: 'default' | 'center' | 'inline';
}) {
  const classes = [
    'empty',
    variant === 'center' ? 'empty--center' : '',
    variant === 'inline' ? 'empty--inline' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={classes}>
      {Icon ? (
        <span className="empty__icon">
          <Icon size={17} aria-hidden />
        </span>
      ) : null}
      {/* An inline empty state reads as a sentence inside a panel that already
          has its own heading; a standalone one is the heading for its region. */}
      {variant === 'inline' ? (
        <span className="t-ui">{title}</span>
      ) : (
        <h2 className="t-heading">{title}</h2>
      )}
      {body ? <p className="t-meta">{body}</p> : null}
      {actions ? <div className="empty__actions">{actions}</div> : null}
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <div className="field__label">
        <label className="t-ui" htmlFor={htmlFor}>
          {label}
        </label>
        {hint ? <span className="field__hint">{hint}</span> : null}
      </div>
      {children}
      {error ? (
        <span className="field__error" id={`${htmlFor}-error`} role="alert">
          <AlertTriangle size={13} aria-hidden style={{ flex: 'none', marginTop: 1 }} />
          {error}
        </span>
      ) : null}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange(next: boolean): void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className="switch"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="switch__text">
        <span className="t-ui">{label}</span>
        {description ? <span className="t-meta">{description}</span> : null}
      </span>
      <span className="switch__track" aria-hidden>
        <span className="switch__thumb" />
      </span>
    </button>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange(next: T): void;
  label: string;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          className="segmented__option"
          // Only the selected option is in the tab order; arrow keys are not
          // needed because the group is small and each option is reachable.
          tabIndex={option.value === value ? 0 : -1}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function CheckIcon() {
  return <Check size={13} aria-hidden />;
}

/**
 * An accessible modal dialog.
 *
 * Handles the four things a dialog has to get right: it traps Tab inside
 * itself, closes on Escape, restores focus to whatever opened it, and marks
 * itself up so a screen reader announces it as a modal with a name.
 */

import { useCallback, useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Button } from './ui';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function useFocusTrap(
  container: React.RefObject<HTMLElement | null>,
  active: boolean,
  onClose: () => void,
) {
  // Captured before focus moves into the dialog, restored when it unmounts.
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;

    const node = container.current;
    if (node) {
      const initial =
        node.querySelector<HTMLElement>('[data-autofocus]') ??
        node.querySelector<HTMLElement>(FOCUSABLE);
      // Falling back to the container keeps focus inside even when the dialog
      // has no interactive content yet.
      (initial ?? node).focus();
    }

    return () => {
      const target = previouslyFocused.current;
      if (target && document.contains(target)) target.focus();
    };
  }, [active, container]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const node = container.current;
      if (!node) return;
      const focusable = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (element) => element.offsetParent !== null || element === document.activeElement,
      );
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [container, onClose],
  );

  return onKeyDown;
}

export function Dialog({
  title,
  description,
  onClose,
  children,
  footer,
  wide,
  labelId,
}: {
  title: string;
  description?: string;
  onClose(): void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  labelId?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const generatedId = useId();
  const titleId = labelId ?? `${generatedId}-title`;
  const descriptionId = `${generatedId}-description`;
  const onKeyDown = useFocusTrap(container, true, onClose);

  return (
    <div
      className="scrim scrim--center"
      // A click that starts inside the dialog and ends on the scrim should
      // not close it, so only direct presses on the scrim count.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={container}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        className={`dialog${wide ? ' dialog--wide' : ''}`}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header className="dialog__head">
          <div className="dialog__title">
            <h2 className="t-heading" id={titleId}>
              {title}
            </h2>
            {description ? (
              <p className="t-meta" id={descriptionId}>
                {description}
              </p>
            ) : null}
          </div>
          <Button
            variant="ghost"
            icon
            size="sm"
            className="dialog__close"
            onClick={onClose}
            aria-label="Close dialog"
          >
            <X size={15} aria-hidden />
          </Button>
        </header>

        <div className="dialog__body">{children}</div>

        {footer ? <footer className="dialog__foot">{footer}</footer> : null}
      </div>
    </div>
  );
}

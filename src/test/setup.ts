/**
 * Test environment shims.
 *
 * jsdom implements the DOM but not the layout- and device-dependent APIs the
 * app legitimately uses. Each stub here stands in for something jsdom does not
 * provide at all — none of them replace application behaviour.
 */

import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// jsdom ships a matchMedia that reports `matches: false` for every query,
// which would make every test behave as a narrow window. A desktop app's
// baseline is a wide one; tests that care about narrow layouts override this.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  configurable: true,
  value: (query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }),
});

// jsdom has no layout, so scrolling is a no-op rather than an error.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

if (typeof CSS === 'undefined' || !CSS.escape) {
  Object.defineProperty(globalThis, 'CSS', {
    writable: true,
    value: { escape: (value: string) => value.replace(/["\\]/g, '\\$&') },
  });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

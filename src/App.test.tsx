/**
 * Shell tests.
 *
 * These cover what only the composition root can be responsible for: the boot
 * sequence and its failure path, the appearance attributes on `<html>`, the
 * global shortcuts, and which pane the main area shows.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';
import { createDemoClient } from '@/lib/demo';
import type { WorkspaceClient } from '@/lib/ipc';
import { useAppStore } from '@/state/store';

const store = () => useAppStore.getState();

function demo(options: Parameters<typeof createDemoClient>[0] = {}) {
  return createDemoClient({ storage: null, seed: true, tickMs: 1, ...options });
}

/** Renders the app and waits for the boot sequence to settle. */
async function mount(client: WorkspaceClient = demo()) {
  store().__reset(client);
  const user = userEvent.setup();
  const view = render(<App />);
  await ready();
  return { user, ...view };
}

/**
 * Waits for the shell. The project list is the landmark to key off: `banner`
 * would be ambiguous, because aria-query reports every `<header>` as one
 * without applying the scoping constraint that excludes the one inside `main`.
 */
function ready() {
  return screen.findByRole('navigation', { name: 'Projects' });
}

/** Forces the window to report a given viewport width for one test. */
function setViewport(wide: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: wide,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

const shell = () => document.querySelector('.shell');

beforeEach(() => {
  // setViewport is global and would otherwise leak into every later test.
  setViewport(true);
  store().__reset(demo({ seed: false }));
});

afterEach(() => {
  store().teardown();
});

// --- boot -----------------------------------------------------------------

describe('boot', () => {
  it('says what it is doing before the workspace has loaded', async () => {
    let release: (() => void) | null = null;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const base = demo();
    const client: WorkspaceClient = {
      ...base,
      loadWorkspace: async () => {
        await held;
        return base.loadWorkspace();
      },
    };

    store().__reset(client);
    render(<App />);

    expect(screen.getByText(/Reading your workspace/)).toBeInTheDocument();
    expect(shell()).not.toBeInTheDocument();

    release!();
    await ready();
    expect(screen.queryByText(/Reading your workspace/)).not.toBeInTheDocument();
  });

  it('renders the shell once the workspace is ready', async () => {
    await mount();

    expect(shell()).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Projects' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'ZARChat' })).toBeInTheDocument();
  });

  it('explains a failure to load and offers a way out', async () => {
    let attempts = 0;
    const base = demo();
    const client: WorkspaceClient = {
      ...base,
      loadWorkspace: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw { code: 'STORE_UNREADABLE', message: 'workspace.json is not valid JSON.' };
        }
        return base.loadWorkspace();
      },
    };

    store().__reset(client);
    const user = userEvent.setup();
    render(<App />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('could not open your workspace');
    expect(alert).toHaveTextContent('workspace.json is not valid JSON.');
    expect(shell()).not.toBeInTheDocument();

    // Retrying succeeds, and the shell replaces the failure.
    await user.click(screen.getByRole('button', { name: /Try again/ }));
    await ready();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

// --- appearance -----------------------------------------------------------

describe('appearance', () => {
  it('publishes the saved settings as attributes on the document', async () => {
    await mount();

    expect(document.documentElement.dataset.theme).toBe('midnight');
    expect(document.documentElement.dataset.accent).toBe('ember');
    expect(document.documentElement.dataset.density).toBe('comfortable');
    expect(document.documentElement.dataset.motion).toBe('system');
  });

  it('follows a settings change immediately', async () => {
    await mount();

    await store().saveSettings({ theme: 'graphite', accent: 'sage', density: 'compact' });
    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('graphite');
    });
    expect(document.documentElement.dataset.accent).toBe('sage');
    expect(document.documentElement.dataset.density).toBe('compact');
  });

  it("keeps 'system' as a real value so the stylesheet can resolve it", async () => {
    await mount();
    await store().saveSettings({ motion: 'system' });

    await waitFor(() => {
      expect(document.documentElement.dataset.motion).toBe('system');
    });
  });
});

// --- the main pane --------------------------------------------------------

describe('main pane', () => {
  it('invites you to add a project when the workspace is empty', async () => {
    await mount(demo({ seed: false }));

    expect(screen.getByRole('heading', { name: 'No projects yet' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add your first project/ })).toBeInTheDocument();
  });

  it('offers a way back when there are projects but none is selected', async () => {
    await mount();
    await store().selectProject(null);

    expect(
      await screen.findByRole('heading', { name: 'Nothing selected' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open ZARChat/ })).toBeInTheDocument();
  });

  it('shows the overview of whichever project is selected', async () => {
    await mount();

    expect(screen.getByRole('heading', { level: 1, name: 'ZARChat' })).toBeInTheDocument();
    await store().selectProject('prj_demo_lumen');
    expect(await screen.findByRole('heading', { level: 1, name: 'LUMEN' })).toBeInTheDocument();
  });

  it('warns that this is a preview when there is no native backend', async () => {
    await mount();
    expect(screen.getByText(/Browser preview/)).toBeInTheDocument();
  });

  it('shows no preview banner for a native backend', async () => {
    await mount({ ...demo(), native: true });
    expect(screen.queryByText(/Browser preview/)).not.toBeInTheDocument();
  });
});

// --- keyboard -------------------------------------------------------------

describe('keyboard shortcuts', () => {
  it('opens and closes the palette with the modifier and K', async () => {
    const { user } = await mount();

    await user.keyboard('{Control>}k{/Control}');
    expect(screen.getByRole('combobox')).toBeInTheDocument();
    expect(store().overlay).toBe('palette');

    await user.keyboard('{Control>}k{/Control}');
    expect(store().overlay).toBeNull();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('opens settings with the modifier and comma', async () => {
    const { user } = await mount();

    await user.keyboard('{Control>},{/Control}');
    expect(store().overlay).toBe('settings');
    expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
  });

  it('collapses and restores the sidebar with the modifier and B', async () => {
    const { user } = await mount();
    expect(shell()).toHaveAttribute('data-sidebar', 'expanded');

    await user.keyboard('{Control>}b{/Control}');
    expect(shell()).toHaveAttribute('data-sidebar', 'collapsed');

    await user.keyboard('{Control>}b{/Control}');
    expect(shell()).toHaveAttribute('data-sidebar', 'expanded');
  });

  it('jumps to a project by position', async () => {
    const { user } = await mount();

    await user.keyboard('{Control>}2{/Control}');
    await waitFor(() => {
      expect(store().selectedId).toBe('prj_demo_lumen');
    });
  });

  it('ignores a position with no project behind it', async () => {
    const { user } = await mount();
    const before = store().selectedId;

    await user.keyboard('{Control>}9{/Control}');
    expect(store().selectedId).toBe(before);
  });

  it('leaves plain typing alone', async () => {
    const { user } = await mount();

    await user.keyboard('kb,');
    expect(store().overlay).toBeNull();
    expect(shell()).toHaveAttribute('data-sidebar', 'expanded');
  });
});

// --- sidebar ---------------------------------------------------------------

describe('sidebar', () => {
  it('starts collapsed on a narrow window', async () => {
    setViewport(false);
    await mount();
    expect(shell()).toHaveAttribute('data-sidebar', 'collapsed');
  });

  it('toggles from the topbar button', async () => {
    const { user } = await mount();

    await user.click(screen.getByRole('button', { name: 'Hide project list' }));
    expect(shell()).toHaveAttribute('data-sidebar', 'collapsed');

    await user.click(screen.getByRole('button', { name: 'Show project list' }));
    expect(shell()).toHaveAttribute('data-sidebar', 'expanded');
  });

  it('gets out of the way after a pick on a narrow window', async () => {
    setViewport(false);
    const { user } = await mount();

    await user.click(screen.getByRole('button', { name: 'Show project list' }));
    expect(shell()).toHaveAttribute('data-sidebar', 'expanded');

    await user.click(screen.getByRole('button', { name: /LUMEN/ }));
    await waitFor(() => {
      expect(shell()).toHaveAttribute('data-sidebar', 'collapsed');
    });
  });
});

// --- overlays and notifications ------------------------------------------

describe('overlays', () => {
  it('opens the project settings dialog from the overview', async () => {
    const { user } = await mount();

    await user.click(screen.getByRole('button', { name: 'Project settings' }));
    const dialog = await screen.findByRole('dialog', { name: 'Project settings' });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByLabelText('Display name')).toHaveValue('ZARChat');
  });

  it('restores focus to the control that opened a dialog', async () => {
    const { user } = await mount();
    const trigger = screen.getByRole('button', { name: 'Settings' });

    await user.click(trigger);
    await screen.findByRole('dialog', { name: 'Settings' });
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(trigger).toHaveFocus();
    });
  });

  it('falls back to the typed-path dialog when there is no native picker', async () => {
    await mount(demo({ seed: false }));

    await userEvent.click(screen.getByRole('button', { name: /Add your first project/ }));
    expect(await screen.findByRole('dialog', { name: 'Add project' })).toBeInTheDocument();
  });
});

describe('notifications', () => {
  it('shows a toast and dismisses it on request', async () => {
    const { user } = await mount();

    store().toast({ level: 'error', title: 'Something went wrong', detail: 'and here is why' });
    expect(await screen.findByText('Something went wrong')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Dismiss: Something went wrong/ }));
    await waitFor(() => {
      expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
    });
  });

  it('retires a success on its own but leaves an error up', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await mount();

    store().toast({ level: 'success', title: 'Saved' });
    store().toast({ level: 'error', title: 'Failed' });
    await screen.findByText('Saved');

    await vi.advanceTimersByTimeAsync(5_000);
    await waitFor(() => {
      expect(screen.queryByText('Saved')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createDemoClient } from '@/lib/demo';
import { useAppStore } from '@/state/store';
import { CommandPalette } from './CommandPalette';

const store = () => useAppStore.getState();

async function setup() {
  store().__reset(createDemoClient({ storage: null, seed: true, tickMs: 1 }));
  await store().bootstrap();
  store().openOverlay('palette');
  return { user: userEvent.setup(), ...render(<CommandPalette />) };
}

const options = () => screen.getAllByRole('option');
const activeOption = () => options().find((option) => option.ariaSelected === 'true');

beforeEach(() => {
  store().__reset(createDemoClient({ storage: null, seed: false }));
});

describe('CommandPalette', () => {
  it('is a labelled modal with a combobox that has focus', async () => {
    await setup();

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Search projects and commands');
    expect(screen.getByRole('combobox')).toHaveFocus();
  });

  it('lists projects, their commands and app actions up front', async () => {
    await setup();

    expect(screen.getByText('Projects')).toBeInTheDocument();
    expect(screen.getByText('Commands')).toBeInTheDocument();
    expect(screen.getByText('Actions')).toBeInTheDocument();
    expect(screen.getByText('ZARChat')).toBeInTheDocument();
    expect(screen.getByText('Open settings')).toBeInTheDocument();
  });

  it('narrows the list as you type', async () => {
    const { user } = await setup();
    const before = options().length;

    await user.type(screen.getByRole('combobox'), 'lumen');
    expect(options().length).toBeLessThan(before);
    expect(within(options()[0]!).getByText(/LUMEN/)).toBeInTheDocument();
  });

  it('matches loosely rather than requiring the exact string', async () => {
    const { user } = await setup();
    await user.type(screen.getByRole('combobox'), 'npmd');
    expect(within(options()[0]!).getByText(/npm run dev/)).toBeInTheDocument();
  });

  it('highlights the part of the title that matched', async () => {
    const { user } = await setup();
    await user.type(screen.getByRole('combobox'), 'lum');

    const marks = within(options()[0]!).getAllByText(/lum/i, { selector: 'mark' });
    expect(marks.length).toBeGreaterThan(0);
  });

  it('says so when nothing matches, and suggests what to try', async () => {
    const { user } = await setup();
    await user.type(screen.getByRole('combobox'), 'zzzzqqq');

    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText(/Nothing matches/)).toBeInTheDocument();
  });

  it('starts on the best match and moves with the arrow keys', async () => {
    const { user } = await setup();
    const first = options()[0];
    expect(first?.ariaSelected).toBe('true');

    await user.keyboard('{ArrowDown}');
    expect(activeOption()).toBe(options()[1]);

    await user.keyboard('{ArrowUp}');
    expect(activeOption()).toBe(options()[0]);
  });

  it('wraps around at both ends', async () => {
    const { user } = await setup();
    await user.keyboard('{ArrowUp}');
    expect(activeOption()).toBe(options().at(-1));

    await user.keyboard('{ArrowDown}');
    expect(activeOption()).toBe(options()[0]);
  });

  it('jumps to the ends with Home and End', async () => {
    const { user } = await setup();
    await user.keyboard('{End}');
    expect(activeOption()).toBe(options().at(-1));

    await user.keyboard('{Home}');
    expect(activeOption()).toBe(options()[0]);
  });

  it('points assistive technology at the active row', async () => {
    const { user } = await setup();
    const combobox = screen.getByRole('combobox');

    expect(combobox).toHaveAttribute('aria-activedescendant', options()[0]!.id);
    await user.keyboard('{ArrowDown}');
    expect(combobox).toHaveAttribute('aria-activedescendant', options()[1]!.id);
  });

  it('selects a project on Enter and closes', async () => {
    const { user } = await setup();
    await user.type(screen.getByRole('combobox'), 'lumen');
    await user.keyboard('{Enter}');

    expect(store().selectedId).toBe('prj_demo_lumen');
    expect(store().overlay).toBeNull();
  });

  it('runs a command on Enter', async () => {
    const { user } = await setup();
    await user.type(screen.getByRole('combobox'), 'npm test');
    await user.keyboard('{Enter}');

    await vi.waitFor(() => {
      expect(Object.values(store().runs)).toHaveLength(1);
    });
    expect(Object.values(store().runs)[0]?.command).toBe('npm test');
  });

  it('runs the row you click', async () => {
    const { user } = await setup();
    await user.type(screen.getByRole('combobox'), 'lumen');
    await user.click(options()[0]!);

    expect(store().selectedId).toBe('prj_demo_lumen');
    expect(store().overlay).toBeNull();
  });

  it('opens settings from the palette', async () => {
    const { user } = await setup();
    await user.type(screen.getByRole('combobox'), 'open settings');
    await user.keyboard('{Enter}');

    expect(store().overlay).toBe('settings');
  });

  it('closes on Escape without running anything', async () => {
    const { user } = await setup();
    const selectedBefore = store().selectedId;

    await user.keyboard('{Escape}');
    expect(store().overlay).toBeNull();
    expect(store().selectedId).toBe(selectedBefore);
    expect(Object.values(store().runs)).toHaveLength(0);
  });

  it('does nothing on Enter when there is nothing to run', async () => {
    const { user } = await setup();
    await user.type(screen.getByRole('combobox'), 'zzzzqqq');
    await user.keyboard('{Enter}');

    expect(store().overlay).toBe('palette');
  });

  it('offers only the actions a project actually supports', async () => {
    const { user } = await setup();
    // ZARChat has a repository URL; LUMEN does not.
    await user.type(screen.getByRole('combobox'), 'repository');
    expect(screen.getAllByRole('option').length).toBeGreaterThan(0);

    await store().selectProject('prj_demo_lumen');
    await user.clear(screen.getByRole('combobox'));
    await user.type(screen.getByRole('combobox'), 'repository');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });
});

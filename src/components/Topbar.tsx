import { PanelLeft, Search, Settings2 } from 'lucide-react';
import { modifierKey } from '@/lib/format';
import { useAppStore } from '@/state/store';
import { Button, Kbd } from './ui';

export function Topbar({
  sidebarOpen,
  onToggleSidebar,
}: {
  sidebarOpen: boolean;
  onToggleSidebar(): void;
}) {
  const openOverlay = useAppStore((s) => s.openOverlay);
  const modifier = modifierKey();

  return (
    <header className="topbar">
      <Button
        variant="ghost"
        icon
        size="sm"
        onClick={onToggleSidebar}
        aria-label={sidebarOpen ? 'Hide project list' : 'Show project list'}
        aria-expanded={sidebarOpen}
        aria-controls="project-sidebar"
      >
        <PanelLeft size={15} aria-hidden />
      </Button>

      <div className="brand">
        <span className="brand__mark" aria-hidden>
          ›_
        </span>
        <span className="brand__name">DevWorkspace</span>
        <span className="brand__tagline">your projects. one command center.</span>
      </div>

      <div className="topbar__spacer" />

      <button
        type="button"
        className="omnibar"
        onClick={() => openOverlay('palette')}
        aria-keyshortcuts="Control+K Meta+K"
      >
        <Search size={14} aria-hidden style={{ flex: 'none' }} />
        <span className="omnibar__label">Search projects and commands</span>
        <Kbd>
          {modifier}
          <span aria-hidden>+</span>K
        </Kbd>
      </button>

      <div className="topbar__actions">
        <Button
          variant="ghost"
          icon
          size="sm"
          onClick={() => openOverlay('settings')}
          aria-label="Settings"
        >
          <Settings2 size={15} aria-hidden />
        </Button>
      </div>
    </header>
  );
}

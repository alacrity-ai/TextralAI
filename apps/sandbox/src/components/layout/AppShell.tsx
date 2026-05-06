import { type ReactNode, useState } from 'react';
import { Navbar } from './Navbar.js';
import { CommandPalette } from '../CommandPalette.js';
import { HelpOverlay } from '../HelpOverlay.js';
import { useHotkeys } from '../../hooks/useHotkeys.js';
import { colors } from '../../styles/tokens.js';

export function AppShell({ children }: { children: ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  useHotkeys({
    'mod+k': (e) => {
      e.preventDefault();
      setPaletteOpen(true);
    },
    '?': () => setHelpOpen(true),
    'shift+/': () => setHelpOpen(true),
    escape: () => {
      setPaletteOpen(false);
      setHelpOpen(false);
    },
  });

  return (
    <div
      style={{
        minHeight: '100vh',
        background: colors.bgBase,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Navbar />
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>{children}</main>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <HelpOverlay open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}

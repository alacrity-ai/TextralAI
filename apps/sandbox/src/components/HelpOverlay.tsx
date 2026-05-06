import { colors, radii, spacing } from '../styles/tokens.js';

interface Props {
  open: boolean;
  onClose: () => void;
}

const SHORTCUTS = [
  {
    group: 'Global',
    items: [
      { keys: '⌘ K', desc: 'Open command palette' },
      { keys: '?', desc: 'Show this help' },
      { keys: 'Esc', desc: 'Close drawer / dialog / palette' },
    ],
  },
  {
    group: 'Query Bench',
    items: [
      { keys: '⌘ Enter', desc: 'Run query' },
      { keys: '⌘ A', desc: 'Open AnswerAuditDrawer' },
    ],
  },
  {
    group: 'Reference',
    items: [
      { keys: '/docs', desc: 'Scalar API reference (new tab)' },
      { keys: '/openapi.json', desc: 'Raw OpenAPI spec' },
    ],
  },
];

export function HelpOverlay({ open, onClose }: Props) {
  if (!open) return null;
  return (
    <>
      <div onClick={onClose} style={backdrop} />
      <div style={modal}>
        <header style={header}>
          <h3 style={{ margin: 0, color: colors.textPrimary, fontSize: 16, fontWeight: 500 }}>
            Sandbox shortcuts
          </h3>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              color: colors.textMuted,
              fontSize: 20,
              cursor: 'pointer',
            }}
          >
            ×
          </button>
        </header>
        <div style={body}>
          {SHORTCUTS.map((group) => (
            <div key={group.group} style={{ marginBottom: spacing.md }}>
              <div
                style={{
                  fontSize: 10,
                  textTransform: 'uppercase',
                  color: colors.textMuted,
                  letterSpacing: '0.18em',
                  marginBottom: 8,
                  fontWeight: 500,
                }}
              >
                {group.group}
              </div>
              {group.items.map((i) => (
                <div key={i.keys} style={row}>
                  <span style={{ color: colors.textSecondary, fontSize: 13 }}>{i.desc}</span>
                  <kbd style={kbdStyle}>{i.keys}</kbd>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

const backdrop: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.5)',
  zIndex: 500,
};
const modal: React.CSSProperties = {
  position: 'fixed',
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  width: 'min(480px, 90vw)',
  zIndex: 501,
  background: colors.bgCard,
  border: `1px solid ${colors.border}`,
  borderRadius: radii.lg,
  boxShadow: '0 24px 60px rgba(0,0,0,0.6)',
};
const header: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '14px 18px',
  borderBottom: `1px solid ${colors.border}`,
};
const body: React.CSSProperties = {
  padding: '14px 18px',
  maxHeight: '70vh',
  overflow: 'auto',
};
const row: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '4px 0',
};
const kbdStyle: React.CSSProperties = {
  background: colors.bgElevated,
  color: colors.textSecondary,
  border: `1px solid ${colors.border}`,
  borderRadius: 4,
  padding: '2px 8px',
  fontSize: 11,
  fontFamily: "'JetBrains Mono', monospace",
};

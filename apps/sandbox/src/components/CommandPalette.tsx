import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { colors, radii, spacing } from '../styles/tokens.js';
import { useApiKey } from '../auth/ApiKeyContext.js';
import { apiUrl } from '../api/client.js';

interface Command {
  id: string;
  label: string;
  hint?: string;
  run: () => void | Promise<void>;
}

function fuzzyMatch(query: string, text: string): boolean {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let i = 0;
  for (const ch of q) {
    const next = t.indexOf(ch, i);
    if (next === -1) return false;
    i = next + 1;
  }
  return true;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export function CommandPalette({ open, onClose }: Props) {
  const navigate = useNavigate();
  const { setKey } = useApiKey();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setSelected(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const all: Command[] = useMemo(
    () => [
      { id: 'goto-query', label: 'Go to Query Bench', hint: '/', run: () => navigate('/') },
      {
        id: 'goto-hist',
        label: 'Open Query History',
        hint: '/history',
        run: () => navigate('/history'),
      },
      { id: 'goto-ing', label: 'Open Ingest', hint: '/ingest', run: () => navigate('/ingest') },
      { id: 'goto-cmp', label: 'Open Compare', hint: '/compare', run: () => navigate('/compare') },
      {
        id: 'goto-ns',
        label: 'Browse Namespaces',
        hint: '/namespaces',
        run: () => navigate('/namespaces'),
      },
      {
        id: 'goto-docs',
        label: 'Inspect Documents',
        hint: '/documents',
        run: () => navigate('/documents'),
      },
      {
        id: 'goto-keys',
        label: 'Manage Provider Keys',
        hint: '/provider-keys',
        run: () => navigate('/provider-keys'),
      },
      { id: 'goto-admin', label: 'Open Admin', hint: '/admin', run: () => navigate('/admin') },
      {
        id: 'open-spec',
        label: 'Open API reference (/docs)',
        hint: 'new tab',
        run: () => {
          window.open(apiUrl('/docs'), '_blank', 'noopener,noreferrer');
        },
      },
      {
        id: 'open-openapi',
        label: 'Open OpenAPI JSON',
        hint: 'new tab',
        run: () => {
          window.open(apiUrl('/openapi.json'), '_blank', 'noopener,noreferrer');
        },
      },
      {
        id: 'forget-key',
        label: 'Forget API key',
        hint: 'destructive',
        run: () => setKey(null),
      },
    ],
    [navigate, setKey],
  );

  const filtered = useMemo(() => {
    if (!query.trim()) return all.slice(0, 12);
    return all.filter((c) => fuzzyMatch(query, c.label)).slice(0, 20);
  }, [all, query]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  if (!open) return null;

  const run = (cmd: Command) => {
    onClose();
    setTimeout(() => cmd.run(), 0);
  };

  return (
    <>
      <div onClick={onClose} style={backdrop} />
      <div style={palette}>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSelected((s) => Math.min(s + 1, filtered.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSelected((s) => Math.max(s - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              const target = filtered[selected];
              if (target) run(target);
            }
          }}
          placeholder="Type a command…"
          style={input}
        />
        <div style={results}>
          {filtered.length === 0 ? (
            <div style={emptyRow}>No matches.</div>
          ) : (
            filtered.map((cmd, i) => (
              <div
                key={cmd.id}
                onMouseEnter={() => setSelected(i)}
                onClick={() => run(cmd)}
                style={{
                  ...row,
                  background: i === selected ? colors.primaryMuted : 'transparent',
                }}
              >
                <span style={{ color: i === selected ? colors.accent : colors.textPrimary }}>
                  {cmd.label}
                </span>
                {cmd.hint && <span style={hintStyle}>{cmd.hint}</span>}
              </div>
            ))
          )}
        </div>
        <div style={footer}>
          <span>↑↓ navigate</span>
          <span>↵ select</span>
          <span>esc close</span>
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
const palette: React.CSSProperties = {
  position: 'fixed',
  top: '15vh',
  left: '50%',
  transform: 'translateX(-50%)',
  width: 'min(600px, 90vw)',
  zIndex: 501,
  background: colors.bgCard,
  border: `1px solid ${colors.border}`,
  borderRadius: radii.lg,
  boxShadow: '0 24px 60px rgba(0,0,0,0.6)',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
};
const input: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  outline: 'none',
  color: colors.textPrimary,
  fontSize: 15,
  padding: '14px 18px',
  borderBottom: `1px solid ${colors.border}`,
};
const results: React.CSSProperties = {
  maxHeight: '50vh',
  overflowY: 'auto',
  padding: spacing.xs,
};
const row: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '8px 12px',
  fontSize: 13,
  borderRadius: radii.sm,
  cursor: 'pointer',
};
const hintStyle: React.CSSProperties = {
  color: colors.textMuted,
  fontSize: 11,
  fontFamily: "'JetBrains Mono', monospace",
};
const emptyRow: React.CSSProperties = {
  padding: '16px',
  color: colors.textMuted,
  fontSize: 13,
  textAlign: 'center',
};
const footer: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 12,
  padding: '8px 14px',
  borderTop: `1px solid ${colors.border}`,
  fontSize: 11,
  color: colors.textMuted,
};

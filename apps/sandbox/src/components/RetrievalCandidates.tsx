import { useMemo, useState } from 'react';
import { Badge } from './ui/Badge.js';
import { colors, fonts, radii, spacing } from '../styles/tokens.js';

export interface Candidate {
  rank: number;
  chunk_id: string;
  section_path: string | null;
  dense_score: number | null;
  sparse_score: number | null;
  rrf: number | null;
  cited: boolean;
}

type SortKey = 'rank' | 'dense' | 'sparse' | 'rrf' | 'cited';

interface Props {
  candidates: Candidate[];
  onPickChunk?: (chunkId: string) => void;
}

export function RetrievalCandidates({ candidates, onPickChunk }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>('rank');
  const [asc, setAsc] = useState(true);

  const sorted = useMemo(() => {
    const arr = [...candidates];
    arr.sort((a, b) => {
      const av = pick(a, sortKey);
      const bv = pick(b, sortKey);
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return asc ? av - bv : bv - av;
    });
    return arr;
  }, [candidates, sortKey, asc]);

  if (candidates.length === 0) {
    return (
      <div style={emptyStyle}>
        <div
          style={{
            fontSize: 10,
            textTransform: 'uppercase',
            letterSpacing: '0.22em',
            color: colors.primary,
            marginBottom: spacing.sm,
          }}
        >
          Retrieval candidates
        </div>
        <div style={{ color: colors.textMuted, fontFamily: fonts.serif, fontStyle: 'italic' }}>
          No candidates returned. The audit drawer has the retrieval status; the per-chunk breakdown
          will land when the backend surfaces hits in{' '}
          <code style={codeInline}>/v1/query-events/{'{id}'}/candidates</code>.
        </div>
      </div>
    );
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) setAsc((a) => !a);
    else {
      setSortKey(key);
      setAsc(key === 'rank');
    }
  }

  return (
    <div style={wrapperStyle}>
      <div style={headerStyle}>
        <div
          style={{
            fontSize: 10,
            textTransform: 'uppercase',
            letterSpacing: '0.22em',
            color: colors.primary,
            fontWeight: 500,
          }}
        >
          Retrieval candidates ({candidates.length})
        </div>
        <span
          style={{
            fontSize: 11,
            color: colors.textMuted,
            fontFamily: fonts.serif,
            fontStyle: 'italic',
          }}
        >
          Click a row to inspect the chunk.
        </span>
      </div>

      <table style={tableStyle}>
        <thead>
          <tr>
            <Th
              label="rank"
              active={sortKey === 'rank'}
              asc={asc}
              onClick={() => toggleSort('rank')}
            />
            <Th
              label="chunk_id"
              active={false}
              asc={asc}
              onClick={() => undefined}
              sortable={false}
            />
            <Th
              label="section path"
              active={false}
              asc={asc}
              onClick={() => undefined}
              sortable={false}
            />
            <Th
              label="dense"
              active={sortKey === 'dense'}
              asc={asc}
              onClick={() => toggleSort('dense')}
              numeric
            />
            <Th
              label="sparse"
              active={sortKey === 'sparse'}
              asc={asc}
              onClick={() => toggleSort('sparse')}
              numeric
            />
            <Th
              label="rrf"
              active={sortKey === 'rrf'}
              asc={asc}
              onClick={() => toggleSort('rrf')}
              numeric
            />
            <Th
              label="cited?"
              active={sortKey === 'cited'}
              asc={asc}
              onClick={() => toggleSort('cited')}
            />
          </tr>
        </thead>
        <tbody>
          {sorted.map((c) => (
            <tr
              key={c.chunk_id}
              onClick={() => onPickChunk?.(c.chunk_id)}
              style={{
                cursor: onPickChunk ? 'pointer' : 'default',
                background: c.cited ? colors.primaryMuted : 'transparent',
                transition: 'background 200ms ease',
              }}
              onMouseEnter={(e) => {
                if (!c.cited)
                  (e.currentTarget as HTMLTableRowElement).style.background = colors.bgElevated;
              }}
              onMouseLeave={(e) => {
                if (!c.cited)
                  (e.currentTarget as HTMLTableRowElement).style.background = 'transparent';
              }}
            >
              <Td mono>{c.rank}</Td>
              <Td mono small>
                {c.chunk_id.slice(0, 14)}…
              </Td>
              <Td>
                <span
                  style={{
                    color: c.section_path ? colors.textSecondary : colors.textMuted,
                    fontFamily: fonts.serif,
                    fontStyle: c.section_path ? 'normal' : 'italic',
                  }}
                >
                  {c.section_path ?? '(no section)'}
                </span>
              </Td>
              <Td mono numeric>
                {fmtScore(c.dense_score)}
              </Td>
              <Td mono numeric>
                {fmtScore(c.sparse_score)}
              </Td>
              <Td mono numeric>
                {fmtScore(c.rrf)}
              </Td>
              <Td>
                {c.cited ? (
                  <Badge variant="success">cited</Badge>
                ) : (
                  <Badge variant="neutral">—</Badge>
                )}
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function pick(c: Candidate, k: SortKey): number | null {
  switch (k) {
    case 'rank':
      return c.rank;
    case 'dense':
      return c.dense_score;
    case 'sparse':
      return c.sparse_score;
    case 'rrf':
      return c.rrf;
    case 'cited':
      return c.cited ? 1 : 0;
  }
}

function fmtScore(s: number | null): string {
  if (s === null) return '—';
  return s.toFixed(3);
}

function Th({
  label,
  active,
  asc,
  onClick,
  numeric,
  sortable = true,
}: {
  label: string;
  active: boolean;
  asc: boolean;
  onClick: () => void;
  numeric?: boolean;
  sortable?: boolean;
}) {
  return (
    <th
      onClick={sortable ? onClick : undefined}
      style={{
        padding: '8px 12px',
        textAlign: numeric ? 'right' : 'left',
        fontSize: 10,
        textTransform: 'uppercase',
        letterSpacing: '0.18em',
        color: active ? colors.primary : colors.textMuted,
        fontWeight: 500,
        cursor: sortable ? 'pointer' : 'default',
        borderBottom: `1px solid ${colors.border}`,
        userSelect: 'none',
      }}
    >
      {label}
      {active && <span style={{ marginLeft: 4 }}>{asc ? '↑' : '↓'}</span>}
    </th>
  );
}

function Td({
  children,
  mono,
  small,
  numeric,
}: {
  children: React.ReactNode;
  mono?: boolean;
  small?: boolean;
  numeric?: boolean;
}) {
  return (
    <td
      style={{
        padding: '10px 12px',
        fontSize: small ? 11 : 12,
        fontFamily: mono ? fonts.mono : fonts.sans,
        color: colors.textPrimary,
        textAlign: numeric ? 'right' : 'left',
        borderBottom: `1px solid ${colors.border}`,
        verticalAlign: 'middle',
      }}
    >
      {children}
    </td>
  );
}

const wrapperStyle: React.CSSProperties = {
  background: colors.bgCard,
  border: `1px solid ${colors.border}`,
  borderRadius: radii.lg,
  overflow: 'hidden',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: `${spacing.md}px ${spacing.lg}px`,
  borderBottom: `1px solid ${colors.border}`,
};

const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
};

const emptyStyle: React.CSSProperties = {
  padding: spacing.lg,
  background: colors.bgCard,
  border: `1px solid ${colors.border}`,
  borderRadius: radii.lg,
};

const codeInline: React.CSSProperties = {
  fontFamily: fonts.mono,
  fontSize: '0.88em',
  background: colors.bgElevated,
  color: colors.accent,
  padding: '1px 5px',
  borderRadius: 3,
};

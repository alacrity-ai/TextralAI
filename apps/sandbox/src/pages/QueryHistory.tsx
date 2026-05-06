import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, TextralApiError } from '../api/client.js';
import type { QueryEvent } from '../api/types.js';
import { Badge } from '../components/ui/Badge.js';
import { EmptyState } from '../components/ui/EmptyState.js';
import { Spinner } from '../components/ui/Spinner.js';
import { Button } from '../components/ui/Button.js';
import { colors, fonts, radii, spacing } from '../styles/tokens.js';

export function QueryHistory() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<QueryEvent[] | null>(null);
  const [err, setErr] = useState<{ code: string; message: string; status: number } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // GET /v1/query-events lists this tenant's events newest-first.
        // The backend also returns `next_cursor` for pagination; we
        // request 100 here, which fits a single page well under the
        // backend's 200 cap. Wire next_cursor when we want infinite-
        // scroll or older-runs lookback.
        const r = await api<{ data: QueryEvent[]; next_cursor: string | null }>(
          'GET',
          '/v1/query-events?limit=100',
        );
        if (cancelled) return;
        setRows(r.data);
      } catch (e) {
        if (cancelled) return;
        if (e instanceof TextralApiError) {
          setErr({ code: e.code, message: e.message, status: e.status });
        } else {
          setErr({ code: 'NETWORK', message: (e as Error).message, status: 0 });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div style={pageStyle}>
      <PageHeader
        title="Query History"
        subtitle="Last 100 queries against this tenant. Click any row to replay it on the Query Bench."
      />

      {loading && (
        <div style={loadingStyle}>
          <Spinner />
        </div>
      )}

      {err && !loading && (
        <div style={errBox}>
          <div
            style={{
              fontSize: 10,
              textTransform: 'uppercase',
              letterSpacing: '0.22em',
              color: colors.danger,
              marginBottom: spacing.sm,
              fontWeight: 500,
            }}
          >
            Failed to load history
          </div>
          <div
            style={{
              fontFamily: fonts.serif,
              fontStyle: 'italic',
              fontSize: 14,
              color: colors.textSecondary,
              lineHeight: 1.6,
            }}
          >
            {err.code}: {err.message}
            <br />
            <br />
            Replay still works for any individual query_event_id —{' '}
            <code style={codeInline}>?replay=qev_…</code> on the Query Bench URL.
          </div>
        </div>
      )}

      {!loading && !err && rows && rows.length === 0 && (
        <EmptyState
          title="No queries yet"
          description="Run something on the Query Bench and it will appear here."
          action={<Button onClick={() => navigate('/')}>Open Query Bench</Button>}
        />
      )}

      {!loading && !err && rows && rows.length > 0 && (
        <div style={tableWrap}>
          <table style={tableStyle}>
            <thead>
              <tr>
                <Th>when</Th>
                <Th>namespace</Th>
                <Th>query</Th>
                <Th numeric>candidates</Th>
                <Th numeric>citations</Th>
                <Th numeric>latency</Th>
                <Th>degradation</Th>
                <Th>status</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => navigate(`/?replay=${r.id}`)}
                  style={rowStyle}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLTableRowElement).style.background = colors.bgElevated;
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLTableRowElement).style.background = 'transparent';
                  }}
                >
                  <Td mono small>
                    {new Date(r.created_at).toLocaleString(undefined, {
                      month: 'short',
                      day: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </Td>
                  <Td>
                    <code style={codeInline}>{r.namespace_id.slice(0, 14)}…</code>
                  </Td>
                  <Td>
                    <span
                      style={{
                        fontFamily: fonts.serif,
                        fontStyle: 'italic',
                        color: colors.textSecondary,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        maxWidth: 320,
                        display: 'inline-block',
                        verticalAlign: 'middle',
                      }}
                    >
                      {r.query_text}
                    </span>
                  </Td>
                  <Td mono numeric>
                    {r.candidates_returned ?? '—'}
                  </Td>
                  <Td mono numeric>
                    {r.citations_returned ?? '—'}
                  </Td>
                  <Td mono numeric>
                    {r.latency_ms !== null ? `${r.latency_ms}ms` : '—'}
                  </Td>
                  <Td>
                    {r.degradation_level ? (
                      <Badge
                        variant={
                          r.degradation_level === 'full'
                            ? 'success'
                            : r.degradation_level === 'partial' ||
                                r.degradation_level === 'no_citations'
                              ? 'warning'
                              : 'danger'
                        }
                      >
                        {r.degradation_level}
                      </Badge>
                    ) : (
                      <Badge variant="neutral">—</Badge>
                    )}
                  </Td>
                  <Td>
                    <Badge
                      variant={
                        r.status === 'completed'
                          ? 'success'
                          : r.status === 'failed'
                            ? 'danger'
                            : 'info'
                      }
                    >
                      {r.status}
                    </Badge>
                  </Td>
                  <Td>
                    <span style={{ color: colors.textMuted, fontSize: 11 }}>↗</span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PageHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div style={{ marginBottom: spacing.xl }}>
      <h1
        style={{
          margin: 0,
          fontFamily: fonts.display,
          fontWeight: 400,
          fontSize: 36,
          letterSpacing: '-0.025em',
          color: colors.textPrimary,
          fontVariationSettings: '"opsz" 144, "SOFT" 30',
        }}
      >
        {title}
      </h1>
      <p
        style={{
          margin: `${spacing.sm}px 0 0`,
          fontFamily: fonts.serif,
          fontStyle: 'italic',
          fontVariationSettings: '"opsz" 14, "SOFT" 80',
          color: colors.textSecondary,
          fontSize: 15,
          maxWidth: 720,
          lineHeight: 1.55,
        }}
      >
        {subtitle}
      </p>
    </div>
  );
}

function Th({ children, numeric }: { children?: React.ReactNode; numeric?: boolean }) {
  return (
    <th
      style={{
        padding: '10px 14px',
        textAlign: numeric ? 'right' : 'left',
        fontSize: 10,
        textTransform: 'uppercase',
        letterSpacing: '0.18em',
        color: colors.textMuted,
        fontWeight: 500,
        borderBottom: `1px solid ${colors.border}`,
        userSelect: 'none',
      }}
    >
      {children}
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
        padding: '12px 14px',
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

const pageStyle: React.CSSProperties = {
  padding: '40px 56px',
  maxWidth: 1500,
  margin: '0 auto',
  width: '100%',
};
const loadingStyle: React.CSSProperties = {
  padding: spacing.xxl,
  display: 'flex',
  justifyContent: 'center',
};
const errBox: React.CSSProperties = {
  padding: spacing.lg,
  background: colors.bgCard,
  border: `1px solid ${colors.warning}`,
  borderRadius: radii.lg,
};
const tableWrap: React.CSSProperties = {
  background: colors.bgCard,
  border: `1px solid ${colors.border}`,
  borderRadius: radii.lg,
  overflow: 'hidden',
};
const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
};
const rowStyle: React.CSSProperties = {
  cursor: 'pointer',
  transition: 'background 200ms ease',
};
const codeInline: React.CSSProperties = {
  fontFamily: fonts.mono,
  fontSize: '0.88em',
  background: colors.bgElevated,
  color: colors.accent,
  padding: '1px 5px',
  borderRadius: 3,
};

import { useEffect, useState } from 'react';
import { api, TextralApiError } from '../api/client.js';
import { useNamespace } from '../context/NamespaceContext.js';
import type { IngestionJob } from '../api/types.js';
import { Card } from '../components/ui/Card.js';
import { Button } from '../components/ui/Button.js';
import { Badge } from '../components/ui/Badge.js';
import { Spinner } from '../components/ui/Spinner.js';
import { EmptyState } from '../components/ui/EmptyState.js';
import { IngestStreamLog } from '../components/IngestStreamLog.js';
import { useActiveJobs } from '../context/ActiveJobsContext.js';
import { useToast } from '../context/ToastContext.js';
import { colors, fonts, radii, spacing } from '../styles/tokens.js';

type Tab = 'jobs' | 'enrichment' | 'mcp';

interface McpToolCall {
  id: string;
  api_key_id: string | null;
  tool_name: string;
  transport: 'stdio' | 'http';
  args_redacted: unknown;
  rest_call_count: number;
  latency_ms: number;
  outcome: 'ok' | 'tool_error' | 'rest_error' | 'cancelled';
  error_code: string | null;
  error_message: string | null;
  created_at: number;
}

interface EnrichmentRun {
  id: string;
  namespace_id: string;
  status: string;
  pass: string | null;
  total: number | null;
  done: number | null;
  failed: number | null;
  started_at: number;
  completed_at: number | null;
}

export function Admin() {
  const [tab, setTab] = useState<Tab>('jobs');

  return (
    <div style={pageStyle}>
      <PageHeader
        title="Admin"
        subtitle="Light operator view — DLQ + retry, plus per-namespace enrichment runs."
      />

      <div style={tabBar}>
        <TabButton active={tab === 'jobs'} onClick={() => setTab('jobs')}>
          Ingestion jobs
        </TabButton>
        <TabButton active={tab === 'enrichment'} onClick={() => setTab('enrichment')}>
          Enrichment runs
        </TabButton>
        <TabButton active={tab === 'mcp'} onClick={() => setTab('mcp')}>
          MCP
        </TabButton>
      </div>

      {tab === 'jobs' && <JobsTab />}
      {tab === 'enrichment' && <EnrichmentTab />}
      {tab === 'mcp' && <McpToolsTab />}
    </div>
  );
}

function McpToolsTab() {
  const [items, setItems] = useState<McpToolCall[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setErr(null);
    try {
      const r = await api<{ items: McpToolCall[]; next_cursor: string | null }>(
        'GET',
        '/v1/admin/mcp_tool_calls?limit=100',
      );
      setItems(r.items);
    } catch (e) {
      const msg = e instanceof TextralApiError ? `${e.code}: ${e.message}` : (e as Error).message;
      setErr(msg);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: spacing.md,
        }}
      >
        <span
          style={{
            fontSize: 12,
            color: colors.textMuted,
            fontStyle: 'italic',
            fontFamily: fonts.serif,
          }}
        >
          Recent MCP tool invocations against your tenant (admin scope required).
        </span>
        <Button size="sm" variant="secondary" onClick={refresh} disabled={loading}>
          Refresh
        </Button>
      </div>

      {loading && (
        <div style={{ padding: spacing.xxl, display: 'flex', justifyContent: 'center' }}>
          <Spinner />
        </div>
      )}

      {err && !loading && <div style={errBox}>{err}</div>}

      {!loading && !err && items && items.length === 0 && (
        <EmptyState
          title="No MCP calls yet"
          description="Connect Claude Code or another MCP client and run a tool to populate this view."
        />
      )}

      {!loading && !err && items && items.length > 0 && (
        <div style={tableWrap}>
          <table style={tableStyle}>
            <thead>
              <tr>
                <Th>created</Th>
                <Th>tool</Th>
                <Th>transport</Th>
                <Th numeric>latency</Th>
                <Th>outcome</Th>
                <Th numeric>rest</Th>
                <Th>error</Th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => {
                const expanded = expandedId === row.id;
                return (
                  <>
                    <tr
                      key={row.id}
                      onClick={() => setExpandedId(expanded ? null : row.id)}
                      style={{ cursor: 'pointer' }}
                    >
                      <Td mono small>
                        {new Date(row.created_at).toLocaleString()}
                      </Td>
                      <Td mono small>
                        {row.tool_name}
                      </Td>
                      <Td>
                        <Badge variant="info">{row.transport}</Badge>
                      </Td>
                      <Td mono numeric>
                        {row.latency_ms}ms
                      </Td>
                      <Td>
                        <Badge
                          variant={
                            row.outcome === 'ok'
                              ? 'success'
                              : row.outcome === 'cancelled'
                                ? 'info'
                                : 'danger'
                          }
                        >
                          {row.outcome}
                        </Badge>
                      </Td>
                      <Td mono numeric>
                        {row.rest_call_count}
                      </Td>
                      <Td mono small>
                        {row.error_code ?? '—'}
                      </Td>
                    </tr>
                    {expanded && (
                      <tr key={`${row.id}-body`}>
                        <td
                          colSpan={7}
                          style={{
                            padding: spacing.md,
                            background: colors.bgElevated,
                            borderBottom: `1px solid ${colors.border}`,
                          }}
                        >
                          <pre
                            style={{
                              margin: 0,
                              fontFamily: fonts.mono,
                              fontSize: 11,
                              color: colors.textSecondary,
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-word',
                            }}
                          >
                            {JSON.stringify(row.args_redacted ?? null, null, 2)}
                          </pre>
                          {row.error_message && (
                            <div
                              style={{
                                marginTop: spacing.sm,
                                padding: spacing.sm,
                                background: 'rgba(166, 64, 56, 0.08)',
                                borderRadius: radii.md,
                                fontFamily: fonts.mono,
                                fontSize: 11,
                                color: colors.danger,
                              }}
                            >
                              {row.error_message}
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function JobsTab() {
  const [items, setItems] = useState<IngestionJob[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [retryJobId, setRetryJobId] = useState<string | null>(null);
  const { showToast } = useToast();
  const activeJobs = useActiveJobs();

  async function refresh() {
    setLoading(true);
    setErr(null);
    try {
      const r = await api<{ items: IngestionJob[]; next_cursor: string | null }>(
        'GET',
        '/v1/admin/ingestion-jobs?dead_lettered=1&limit=100',
      );
      setItems(r.items);
    } catch (e) {
      const msg = e instanceof TextralApiError ? `${e.code}: ${e.message}` : (e as Error).message;
      setErr(msg);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function retry(jobId: string) {
    try {
      await api('POST', `/v1/ingestion-jobs/${jobId}/retry`);
      showToast(`Retry enqueued for ${jobId}`, 'success');
      setRetryJobId(jobId);
      activeJobs.startTracking(jobId);
      void refresh();
    } catch (e) {
      const msg = e instanceof TextralApiError ? `${e.code}: ${e.message}` : (e as Error).message;
      showToast(`Retry failed: ${msg}`, 'error');
    }
  }

  return (
    <>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: spacing.md,
        }}
      >
        <span
          style={{
            fontSize: 12,
            color: colors.textMuted,
            fontStyle: 'italic',
            fontFamily: fonts.serif,
          }}
        >
          Dead-lettered ingestion jobs (admin scope required).
        </span>
        <Button size="sm" variant="secondary" onClick={refresh} disabled={loading}>
          Refresh
        </Button>
      </div>

      {loading && (
        <div style={{ padding: spacing.xxl, display: 'flex', justifyContent: 'center' }}>
          <Spinner />
        </div>
      )}

      {err && !loading && <div style={errBox}>{err}</div>}

      {!loading && !err && items && items.length === 0 && (
        <EmptyState title="DLQ is empty" description="No ingestion jobs have been dead-lettered." />
      )}

      {!loading && !err && items && items.length > 0 && (
        <div style={tableWrap}>
          <table style={tableStyle}>
            <thead>
              <tr>
                <Th>id</Th>
                <Th>document</Th>
                <Th>mode</Th>
                <Th>stage</Th>
                <Th>error</Th>
                <Th numeric>attempts</Th>
                <Th>started</Th>
                <Th>actions</Th>
              </tr>
            </thead>
            <tbody>
              {items.map((j) => (
                <tr key={j.id}>
                  <Td mono small>
                    {j.id.slice(0, 16)}…
                  </Td>
                  <Td mono small>
                    {j.document_id.slice(0, 14)}…
                  </Td>
                  <Td>
                    <Badge variant="info">{j.mode}</Badge>
                  </Td>
                  <Td mono small>
                    {j.current_stage ?? '—'}
                  </Td>
                  <Td>
                    {j.error_code ? (
                      <span>
                        <Badge variant="danger">{j.error_code}</Badge>
                        <div
                          style={{
                            fontSize: 11,
                            color: colors.textMuted,
                            marginTop: 4,
                            maxWidth: 280,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {j.error_message}
                        </div>
                      </span>
                    ) : (
                      '—'
                    )}
                  </Td>
                  <Td mono numeric>
                    {j.attempt_count}
                  </Td>
                  <Td mono small>
                    {new Date(j.created_at).toLocaleString()}
                  </Td>
                  <Td>
                    <Button size="sm" variant="primary" onClick={() => retry(j.id)}>
                      Retry
                    </Button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {retryJobId && (() => {
        const tracked = activeJobs.jobs.find((j) => j.job.id === retryJobId);
        if (!tracked) return null;
        const cancelable = tracked.terminalAt === null;
        return (
          <div style={{ marginTop: spacing.lg }}>
            <div style={sectionLabel}>Retry stream — {retryJobId}</div>
            <div style={{ marginTop: spacing.sm }}>
              <IngestStreamLog
                job={tracked.job}
                stages={tracked.stages}
                startedAt={tracked.job.created_at}
                pollError={tracked.pollError}
                {...(cancelable
                  ? {
                      onCancel: async () => {
                        try {
                          await activeJobs.cancelJob(retryJobId);
                          showToast(`Cancelling ${retryJobId}`, 'info');
                        } catch (e) {
                          const msg =
                            e instanceof TextralApiError
                              ? `${e.code}: ${e.message}`
                              : (e as Error).message;
                          showToast(`Cancel failed: ${msg}`, 'error');
                        }
                      },
                    }
                  : {})}
              />
            </div>
          </div>
        );
      })()}
    </>
  );
}

function EnrichmentTab() {
  const { active, list } = useNamespace();
  const [slug, setSlug] = useState<string>('');
  const [runs, setRuns] = useState<EnrichmentRun[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const { showToast } = useToast();

  useEffect(() => {
    if (active && !slug) setSlug(active.slug);
  }, [active, slug]);

  async function refresh(target: string) {
    if (!target) return;
    setLoading(true);
    setErr(null);
    try {
      const r = await api<{ data: EnrichmentRun[] }>(
        'GET',
        `/v1/admin/namespaces/${target}/enrichment-runs`,
      );
      setRuns(r.data);
    } catch (e) {
      const msg = e instanceof TextralApiError ? `${e.code}: ${e.message}` : (e as Error).message;
      setErr(msg);
      setRuns(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (slug) void refresh(slug);
  }, [slug]);

  async function startRun() {
    if (!slug) return;
    setBusy(true);
    try {
      await api('POST', `/v1/admin/namespaces/${slug}/enrichment-runs`, {});
      showToast(`Enrichment run started for ${slug}`, 'success');
      void refresh(slug);
    } catch (e) {
      const msg = e instanceof TextralApiError ? `${e.code}: ${e.message}` : (e as Error).message;
      showToast(`Start failed: ${msg}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Card ruled style={{ marginBottom: spacing.lg }}>
        <div style={sectionLabel}>Run enrichment</div>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            gap: spacing.md,
            marginTop: spacing.md,
          }}
        >
          <div style={{ flex: 1 }}>
            <label
              style={{
                display: 'block',
                marginBottom: 7,
                fontSize: 11,
                color: colors.textSecondary,
                fontWeight: 500,
                letterSpacing: '0.16em',
                textTransform: 'uppercase',
              }}
            >
              Namespace
            </label>
            <select
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              style={{
                width: '100%',
                padding: '11px 14px',
                background: colors.bgInput,
                color: colors.textPrimary,
                border: `1px solid ${colors.border}`,
                borderRadius: radii.md,
                fontSize: 14,
                fontFamily: "'DM Sans', sans-serif",
                outline: 'none',
                cursor: 'pointer',
              }}
            >
              <option value="" style={{ background: colors.bgElevated }}>
                — pick a namespace —
              </option>
              {list.map((n) => (
                <option key={n.slug} value={n.slug} style={{ background: colors.bgElevated }}>
                  {n.slug}
                </option>
              ))}
            </select>
          </div>
          <Button onClick={startRun} disabled={!slug || busy} loading={busy}>
            Start run
          </Button>
        </div>
      </Card>

      {loading && (
        <div style={{ padding: spacing.xxl, display: 'flex', justifyContent: 'center' }}>
          <Spinner />
        </div>
      )}

      {err && !loading && <div style={errBox}>{err}</div>}

      {!loading && !err && runs && runs.length === 0 && (
        <EmptyState
          title="No runs yet"
          description="Start one above. Runs apply enrichment passes to every chunk in the namespace."
        />
      )}

      {!loading && !err && runs && runs.length > 0 && (
        <div style={tableWrap}>
          <table style={tableStyle}>
            <thead>
              <tr>
                <Th>id</Th>
                <Th>pass</Th>
                <Th>status</Th>
                <Th numeric>done</Th>
                <Th numeric>failed</Th>
                <Th numeric>total</Th>
                <Th>started</Th>
                <Th>completed</Th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <Td mono small>
                    {r.id.slice(0, 16)}…
                  </Td>
                  <Td mono small>
                    {r.pass ?? '—'}
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
                  <Td mono numeric>
                    {r.done ?? '—'}
                  </Td>
                  <Td mono numeric>
                    {r.failed ?? '—'}
                  </Td>
                  <Td mono numeric>
                    {r.total ?? '—'}
                  </Td>
                  <Td mono small>
                    {new Date(r.started_at).toLocaleString()}
                  </Td>
                  <Td mono small>
                    {r.completed_at ? new Date(r.completed_at).toLocaleString() : '—'}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        background: 'transparent',
        border: 'none',
        cursor: 'pointer',
        padding: '12px 4px',
        marginRight: 24,
        fontSize: 11,
        fontWeight: 500,
        letterSpacing: '0.18em',
        textTransform: 'uppercase',
        color: active ? colors.textPrimary : colors.textMuted,
        borderBottom: `2px solid ${active ? colors.primary : 'transparent'}`,
        transition: 'color 200ms ease, border-color 200ms ease',
      }}
    >
      {children}
    </button>
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
const sectionLabel: React.CSSProperties = {
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: '0.22em',
  color: colors.primary,
  fontWeight: 500,
};
const tabBar: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  borderBottom: `1px solid ${colors.border}`,
  marginBottom: spacing.lg,
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
const errBox: React.CSSProperties = {
  padding: spacing.md,
  background: 'rgba(166, 64, 56, 0.08)',
  border: `1px solid ${colors.danger}`,
  borderRadius: radii.md,
  color: colors.danger,
  fontFamily: fonts.mono,
  fontSize: 13,
  marginBottom: spacing.md,
};

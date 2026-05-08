import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useNamespace } from '../context/NamespaceContext.js';
import { api, TextralApiError } from '../api/client.js';
import type {
  Chunk,
  Document,
  IngestionJobCreateResponse,
} from '../api/types.js';
import { Card } from '../components/ui/Card.js';
import { Input } from '../components/ui/Input.js';
import { Button } from '../components/ui/Button.js';
import { Badge } from '../components/ui/Badge.js';
import { EmptyState } from '../components/ui/EmptyState.js';
import { Spinner } from '../components/ui/Spinner.js';
import { SourcePanel } from '../components/SourcePanel.js';
import { IngestStreamLog } from '../components/IngestStreamLog.js';
import { useToast } from '../context/ToastContext.js';
import { useActiveJobs } from '../context/ActiveJobsContext.js';
import { colors, fonts, radii, spacing } from '../styles/tokens.js';

type Tab = 'chunks' | 'metadata' | 'reingest';

interface ListEnvelope<T> {
  data: T[];
  next_cursor: string | null;
}

const PREVIEW_CHARS = 240;

export function DocumentInspector() {
  const { id: paramId } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const { active } = useNamespace();
  const { showToast } = useToast();
  const activeJobs = useActiveJobs();

  const [docId, setDocId] = useState(paramId ?? '');
  const [doc, setDoc] = useState<Document | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [chunks, setChunks] = useState<Chunk[] | null>(null);
  const [chunksNextCursor, setChunksNextCursor] = useState<string | null>(null);
  const [chunksLoadingMore, setChunksLoadingMore] = useState(false);
  const [chunksErr, setChunksErr] = useState<string | null>(null);
  const [openChunk, setOpenChunk] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('chunks');
  const [reingestJob, setReingestJob] = useState<string | null>(null);
  const [reingestBusy, setReingestBusy] = useState(false);

  // Browse state — populated when no `:id` is in the URL and a namespace
  // is active. Lets operators discover documents without having to hand-
  // type a `doc_…` id.
  const [docList, setDocList] = useState<Document[] | null>(null);
  const [docListErr, setDocListErr] = useState<string | null>(null);
  const [docListLoading, setDocListLoading] = useState(false);
  const [docListNextCursor, setDocListNextCursor] = useState<string | null>(null);

  // ── single-document load ─────────────────────────────────────────
  const loadChunks = useCallback(async (id: string) => {
    setChunksErr(null);
    setChunks(null);
    setChunksNextCursor(null);
    try {
      const r = await api<ListEnvelope<Chunk>>('GET', `/v1/documents/${id}/chunks?limit=100`);
      setChunks(r.data);
      setChunksNextCursor(r.next_cursor);
    } catch (e) {
      const msg = e instanceof TextralApiError ? `${e.code}: ${e.message}` : (e as Error).message;
      setChunksErr(msg);
    }
  }, []);

  const loadDoc = useCallback(
    async (id: string) => {
      setLoading(true);
      setErr(null);
      setDoc(null);
      setChunks(null);
      setChunksErr(null);
      try {
        const r = await api<Document>('GET', `/v1/documents/${id}`);
        setDoc(r);
        void loadChunks(id);
      } catch (e) {
        const msg = e instanceof TextralApiError ? `${e.code}: ${e.message}` : (e as Error).message;
        setErr(msg);
      } finally {
        setLoading(false);
      }
    },
    [loadChunks],
  );

  useEffect(() => {
    if (paramId) {
      setDocId(paramId);
      void loadDoc(paramId);
    } else {
      // Returning to /documents — clear single-doc state.
      setDoc(null);
      setChunks(null);
      setErr(null);
    }
  }, [paramId, loadDoc]);

  async function loadMoreChunks() {
    if (!doc || !chunksNextCursor || chunksLoadingMore) return;
    setChunksLoadingMore(true);
    try {
      const r = await api<ListEnvelope<Chunk>>(
        'GET',
        `/v1/documents/${doc.id}/chunks?limit=100&cursor=${encodeURIComponent(chunksNextCursor)}`,
      );
      setChunks((prev) => (prev ? [...prev, ...r.data] : r.data));
      setChunksNextCursor(r.next_cursor);
    } catch (e) {
      const msg = e instanceof TextralApiError ? `${e.code}: ${e.message}` : (e as Error).message;
      showToast(`Couldn't load more chunks: ${msg}`, 'error');
    } finally {
      setChunksLoadingMore(false);
    }
  }

  async function reingest() {
    if (!doc) return;
    setReingestBusy(true);
    try {
      const r = await api<IngestionJobCreateResponse>('POST', `/v1/documents/${doc.id}/ingest`, {
        embedding: {
          provider: 'openai',
          model: 'text-embedding-3-large',
          dimensions: 1536,
          provider_key_ref: 'default',
        },
        chunking: { profile: 'generic', target_tokens: 600, overlap_tokens: 80 },
        mode: 'full',
        force_rebuild: true,
      });
      setReingestJob(r.job_id);
      activeJobs.startTracking(r.job_id);
      showToast(`Reingest job started: ${r.job_id}`, 'success');
    } catch (e) {
      const msg = e instanceof TextralApiError ? `${e.code}: ${e.message}` : (e as Error).message;
      showToast(`Reingest failed: ${msg}`, 'error');
    } finally {
      setReingestBusy(false);
    }
  }

  // ── browse mode (no :id, active namespace) ──────────────────────
  const loadBrowse = useCallback(
    async (slug: string, cursor?: string) => {
      setDocListLoading(!cursor);
      if (!cursor) {
        setDocListErr(null);
        setDocList(null);
      }
      try {
        const url = `/v1/namespaces/${slug}/documents?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const r = await api<ListEnvelope<Document>>('GET', url);
        setDocList((prev) => (cursor && prev ? [...prev, ...r.data] : r.data));
        setDocListNextCursor(r.next_cursor);
      } catch (e) {
        const msg = e instanceof TextralApiError ? `${e.code}: ${e.message}` : (e as Error).message;
        setDocListErr(msg);
      } finally {
        setDocListLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (paramId) return;
    if (!active) {
      setDocList(null);
      return;
    }
    void loadBrowse(active.slug);
  }, [paramId, active, loadBrowse]);

  // ── render ──────────────────────────────────────────────────────
  return (
    <div style={pageStyle}>
      <PageHeader
        title="Document Inspector"
        subtitle="Browse the active namespace, look up a document by id, inspect chunks, or re-ingest with a tweaked profile."
      />

      <Card ruled style={{ marginBottom: spacing.lg }}>
        <div style={sectionLabel}>Lookup</div>
        <div
          style={{
            marginTop: spacing.md,
            display: 'grid',
            gridTemplateColumns: '1fr auto',
            gap: spacing.md,
            alignItems: 'flex-end',
          }}
        >
          <Input
            label="Document ID"
            value={docId}
            onChange={(e) => setDocId(e.target.value)}
            placeholder="doc_..."
            onKeyDown={(e) => {
              if (e.key === 'Enter' && docId.trim()) {
                navigate(`/documents/${docId.trim()}`);
              }
            }}
          />
          <Button
            disabled={!docId.trim() || loading}
            onClick={() => navigate(`/documents/${docId.trim()}`)}
            loading={loading}
          >
            Inspect
          </Button>
        </div>
        <div
          style={{
            marginTop: spacing.sm,
            fontSize: 11,
            color: colors.textMuted,
            fontStyle: 'italic',
          }}
        >
          {active
            ? `Active namespace: ${active.slug}`
            : 'No namespace selected — only direct id lookup will work.'}
        </div>
      </Card>

      {err && <div style={errBox}>{err}</div>}

      {/* Browse mode: no specific doc loaded, list the namespace's docs. */}
      {!paramId && !loading && !err && (
        <BrowseList
          loading={docListLoading}
          err={docListErr}
          list={docList}
          nextCursor={docListNextCursor}
          activeSlug={active?.slug ?? null}
          onPick={(id) => navigate(`/documents/${id}`)}
          onLoadMore={() => active && docListNextCursor && loadBrowse(active.slug, docListNextCursor)}
        />
      )}

      {/* Single-document mode. */}
      {doc && !loading && (
        <>
          <Card style={{ marginBottom: spacing.lg }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={evtIdStyle}>document</div>
                <h2
                  style={{
                    margin: 0,
                    fontFamily: fonts.display,
                    fontWeight: 400,
                    fontSize: 28,
                    color: colors.textPrimary,
                    fontVariationSettings: '"opsz" 144, "SOFT" 30',
                    marginBottom: 6,
                  }}
                >
                  {doc.title ?? '(untitled)'}
                </h2>
                <code style={codeInline}>{doc.id}</code>
              </div>
              <div
                style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}
              >
                {doc.doc_type && <Badge variant="info">{doc.doc_type}</Badge>}
                <span style={{ fontSize: 11, color: colors.textMuted, fontFamily: fonts.mono }}>
                  ns: {doc.namespace_id.slice(0, 14)}…
                </span>
                <span style={{ fontSize: 11, color: colors.textMuted, fontFamily: fonts.mono }}>
                  v: {doc.current_version_id ?? '—'}
                </span>
                <Button size="sm" variant="secondary" onClick={() => navigate('/documents')}>
                  ← Back to list
                </Button>
              </div>
            </div>
          </Card>

          <div style={tabBar}>
            <TabButton active={tab === 'chunks'} onClick={() => setTab('chunks')}>
              Chunks
            </TabButton>
            <TabButton active={tab === 'metadata'} onClick={() => setTab('metadata')}>
              Metadata
            </TabButton>
            <TabButton active={tab === 'reingest'} onClick={() => setTab('reingest')}>
              Re-ingest
            </TabButton>
          </div>

          {tab === 'chunks' && (
            <ChunksTab
              chunks={chunks}
              chunksErr={chunksErr}
              chunksNextCursor={chunksNextCursor}
              chunksLoadingMore={chunksLoadingMore}
              docHasVersion={!!doc.current_version_id}
              onPickChunk={setOpenChunk}
              onLoadMore={loadMoreChunks}
            />
          )}

          {tab === 'metadata' && (
            <Card>
              <pre
                style={{
                  fontFamily: fonts.mono,
                  fontSize: 12,
                  color: colors.textPrimary,
                  background: colors.bgInput,
                  padding: spacing.md,
                  borderRadius: radii.md,
                  border: `1px solid ${colors.border}`,
                  overflow: 'auto',
                  whiteSpace: 'pre',
                }}
              >
                {JSON.stringify(doc, null, 2)}
              </pre>
            </Card>
          )}

          {tab === 'reingest' && (
            <Card>
              <div style={sectionLabel}>Re-ingest with current configuration</div>
              <p
                style={{
                  fontSize: 13,
                  color: colors.textSecondary,
                  fontFamily: fonts.serif,
                  fontStyle: 'italic',
                  margin: `${spacing.sm}px 0 ${spacing.lg}px`,
                  lineHeight: 1.55,
                }}
              >
                Triggers <code style={codeInline}>POST /v1/documents/{'{id}'}/ingest</code> with{' '}
                <code style={codeInline}>force_rebuild: true</code>. To tweak chunking/embedding,
                use the Ingest page directly.
              </p>
              <Button onClick={reingest} disabled={reingestBusy} loading={reingestBusy}>
                Re-ingest
              </Button>
              {reingestJob && (() => {
                const tracked = activeJobs.jobs.find((j) => j.job.id === reingestJob);
                if (!tracked) return null;
                const cancelable =
                  tracked.terminalAt === null && tracked.job.status !== 'completed';
                return (
                  <div style={{ marginTop: spacing.lg }}>
                    <IngestStreamLog
                      job={tracked.job}
                      stages={tracked.stages}
                      startedAt={tracked.job.created_at}
                      pollError={tracked.pollError}
                      {...(cancelable
                        ? {
                            onCancel: async () => {
                              try {
                                await activeJobs.cancelJob(reingestJob);
                                showToast(`Cancelling ${reingestJob}`, 'info');
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
                );
              })()}
            </Card>
          )}
        </>
      )}

      {openChunk && <SourcePanel chunkId={openChunk} onClose={() => setOpenChunk(null)} />}
    </div>
  );
}

// ── browse list ─────────────────────────────────────────────────────

function BrowseList({
  loading,
  err,
  list,
  nextCursor,
  activeSlug,
  onPick,
  onLoadMore,
}: {
  loading: boolean;
  err: string | null;
  list: Document[] | null;
  nextCursor: string | null;
  activeSlug: string | null;
  onPick: (id: string) => void;
  onLoadMore: () => void;
}) {
  if (!activeSlug) {
    return (
      <EmptyState
        title="Pick a namespace"
        description="Select a namespace from the header to browse its documents, or paste a doc_… id above to inspect a specific document."
      />
    );
  }
  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: spacing.xxl }}>
        <Spinner />
      </div>
    );
  }
  if (err) {
    return (
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
          Couldn't list documents
        </div>
        <div style={{ fontFamily: fonts.serif, fontStyle: 'italic', color: colors.textSecondary }}>
          {err}
        </div>
      </div>
    );
  }
  if (!list || list.length === 0) {
    return (
      <EmptyState
        title={`No documents in ${activeSlug}`}
        description="Use the Ingest page to drop a markdown file here. Documents register on first upload."
      />
    );
  }

  return (
    <>
      <div
        style={{
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: '0.22em',
          color: colors.primary,
          fontWeight: 500,
          marginBottom: spacing.sm,
        }}
      >
        Documents in {activeSlug} ({list.length})
      </div>
      <div style={tableWrap}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <Th>title</Th>
              <Th>doc_id</Th>
              <Th>type</Th>
              <Th>current version</Th>
              <Th>created</Th>
            </tr>
          </thead>
          <tbody>
            {list.map((d) => (
              <tr
                key={d.id}
                onClick={() => onPick(d.id)}
                style={{ cursor: 'pointer' }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLTableRowElement).style.background = colors.bgElevated;
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLTableRowElement).style.background = 'transparent';
                }}
              >
                <Td>
                  <span
                    style={{
                      fontFamily: fonts.serif,
                      fontStyle: d.title ? 'normal' : 'italic',
                      color: d.title ? colors.textPrimary : colors.textMuted,
                    }}
                  >
                    {d.title ?? '(untitled)'}
                  </span>
                </Td>
                <Td mono small>
                  {d.id.slice(0, 16)}…
                </Td>
                <Td>
                  {d.doc_type ? (
                    <Badge variant="info">{d.doc_type}</Badge>
                  ) : (
                    <span style={{ color: colors.textMuted }}>—</span>
                  )}
                </Td>
                <Td mono small>
                  {d.current_version_id ? (
                    <code style={codeInline}>{d.current_version_id.slice(0, 14)}…</code>
                  ) : (
                    <span style={{ color: colors.textMuted, fontStyle: 'italic' }}>not ingested</span>
                  )}
                </Td>
                <Td mono small>
                  {new Date(d.created_at).toLocaleString(undefined, {
                    month: 'short',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {nextCursor && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: spacing.md }}>
          <Button variant="secondary" size="sm" onClick={onLoadMore}>
            Load more
          </Button>
        </div>
      )}
    </>
  );
}

// ── chunks tab ──────────────────────────────────────────────────────

function ChunksTab({
  chunks,
  chunksErr,
  chunksNextCursor,
  chunksLoadingMore,
  docHasVersion,
  onPickChunk,
  onLoadMore,
}: {
  chunks: Chunk[] | null;
  chunksErr: string | null;
  chunksNextCursor: string | null;
  chunksLoadingMore: boolean;
  docHasVersion: boolean;
  onPickChunk: (id: string) => void;
  onLoadMore: () => void;
}) {
  if (chunksErr) {
    return (
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
          Couldn't list chunks
        </div>
        <div style={{ fontFamily: fonts.serif, fontStyle: 'italic', color: colors.textSecondary }}>
          {chunksErr}
        </div>
      </div>
    );
  }

  if (!chunks) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: spacing.xxl }}>
        <Spinner />
      </div>
    );
  }

  if (chunks.length === 0) {
    return (
      <EmptyState
        title={docHasVersion ? 'No chunks for this version' : 'Document not yet ingested'}
        description={
          docHasVersion
            ? "The document has a current version but no chunks under it. Try the Re-ingest tab if you expected chunks here."
            : 'Run an ingestion job for this document — the Re-ingest tab is the quickest path.'
        }
      />
    );
  }

  return (
    <>
      <div style={tableWrap}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <Th numeric>ord</Th>
              <Th>chunk_id</Th>
              <Th>section path</Th>
              <Th>artifact</Th>
              <Th>embedding</Th>
              <Th>preview</Th>
            </tr>
          </thead>
          <tbody>
            {chunks.map((c) => (
              <tr
                key={c.id}
                onClick={() => onPickChunk(c.id)}
                style={{ cursor: 'pointer' }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLTableRowElement).style.background = colors.bgElevated;
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLTableRowElement).style.background = 'transparent';
                }}
              >
                <Td mono numeric>
                  {c.ord}
                </Td>
                <Td mono small>
                  {c.id.slice(0, 22)}…
                </Td>
                <Td>
                  <span
                    style={{
                      fontFamily: fonts.serif,
                      fontStyle: c.section_path ? 'normal' : 'italic',
                      color: c.section_path ? colors.textSecondary : colors.textMuted,
                    }}
                  >
                    {c.section_path ?? '(no section)'}
                  </span>
                </Td>
                <Td>
                  <Badge variant="neutral">{c.artifact_type}</Badge>
                </Td>
                <Td>
                  <Badge
                    variant={
                      c.embedding_status === 'embedded'
                        ? 'success'
                        : c.embedding_status === 'missing'
                          ? 'danger'
                          : 'warning'
                    }
                  >
                    {c.embedding_status}
                  </Badge>
                </Td>
                <Td>
                  <span
                    style={{
                      color: colors.textMuted,
                      fontStyle: 'italic',
                      fontFamily: fonts.serif,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      maxWidth: 360,
                      display: 'inline-block',
                      verticalAlign: 'middle',
                    }}
                  >
                    {c.text.slice(0, PREVIEW_CHARS)}
                  </span>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {chunksNextCursor && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: spacing.md }}>
          <Button
            variant="secondary"
            size="sm"
            onClick={onLoadMore}
            loading={chunksLoadingMore}
          >
            Load more chunks
          </Button>
        </div>
      )}
    </>
  );
}

// ── primitives ──────────────────────────────────────────────────────

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
const codeInline: React.CSSProperties = {
  fontFamily: fonts.mono,
  fontSize: '0.88em',
  background: colors.bgElevated,
  color: colors.accent,
  padding: '1px 5px',
  borderRadius: 3,
};
const evtIdStyle: React.CSSProperties = {
  fontSize: 10,
  letterSpacing: '0.22em',
  textTransform: 'uppercase',
  color: colors.primary,
  fontWeight: 500,
  marginBottom: 8,
};

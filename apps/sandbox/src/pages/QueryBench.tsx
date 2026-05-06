import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useNamespace } from '../context/NamespaceContext.js';
import { api, apiRaw, TextralApiError } from '../api/client.js';
import { readSSE } from '../api/sse.js';
import type { QueryEvent, QueryRequest, QueryResponse } from '../api/types.js';
import { QueryForm, type QueryFormState } from '../components/QueryForm.js';
import { requestConfigToFormState } from '../components/queryFormReplay.js';
import { AnswerCard } from '../components/AnswerCard.js';
import { RetrievalCandidates } from '../components/RetrievalCandidates.js';
import { AuditTimeline } from '../components/AuditTimeline.js';
import { AnswerAuditDrawer } from '../components/AnswerAuditDrawer.js';
import { SourcePanel } from '../components/SourcePanel.js';
import { Badge } from '../components/ui/Badge.js';
import { Button } from '../components/ui/Button.js';
import { EmptyState } from '../components/ui/EmptyState.js';
import { useToast } from '../context/ToastContext.js';
import { colors, fonts, radii, spacing } from '../styles/tokens.js';

export function QueryBench() {
  const { active } = useNamespace();
  const { showToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const replayId = searchParams.get('replay');

  const [last, setLast] = useState<QueryResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [chunkOpen, setChunkOpen] = useState<string | null>(null);
  const [streamingText, setStreamingText] = useState<string>('');
  const [streaming, setStreaming] = useState(false);
  // Replay state: when an operator clicks a row in /history, we fetch
  // that query_event, map its request_config to a Partial<QueryFormState>
  // and remount the QueryForm with it. The remount is forced via the
  // `formKey` below — the form's useState initializer only runs at
  // mount, so a stale instance otherwise ignores incoming `initial`
  // props after async fetch completion.
  //
  // We also fetch the mirrored QueryResponse (when one exists) so the
  // right pane on QueryBench hydrates with the historical answer +
  // citations + audit. `lastIsHistorical` flags whether `last` came
  // from a replay so AnswerCard can render a "from history" badge.
  const [replayInitial, setReplayInitial] = useState<Partial<QueryFormState> | null>(null);
  const [replayMeta, setReplayMeta] = useState<{
    eventId: string;
    namespaceId: string;
    createdAt: number;
    degradationLevel: string | null;
    latencyMs: number | null;
  } | null>(null);
  const [replayResponseStatus, setReplayResponseStatus] = useState<{
    available: boolean;
    reason?: string;
    detail?: string;
  } | null>(null);
  const [lastIsHistorical, setLastIsHistorical] = useState(false);
  const [formKey, setFormKey] = useState<string>('default');

  const run = useCallback(
    async (req: QueryRequest, formStream: boolean) => {
      setBusy(true);
      setErr(null);
      setLast(null);
      setLastIsHistorical(false);
      setStreamingText('');
      setStreaming(formStream);
      try {
        if (formStream) {
          // SSE — Step 17 wired.
          const url = '/v1/query?stream=sse';
          const res = await apiRaw('POST', url, req, {
            headers: { accept: 'text/event-stream' },
          });
          if (!res.ok) {
            const t = await res.text();
            throw new Error(`SSE ${res.status}: ${t}`);
          }
          let acc = '';
          let final: QueryResponse | null = null;
          for await (const ev of readSSE(res)) {
            if (ev.event === 'token' || ev.event === 'message') {
              try {
                const payload = JSON.parse(ev.data) as { delta?: string };
                if (payload.delta) {
                  acc += payload.delta;
                  setStreamingText(acc);
                }
              } catch {
                acc += ev.data;
                setStreamingText(acc);
              }
            } else if (ev.event === 'done') {
              try {
                final = JSON.parse(ev.data) as QueryResponse;
              } catch (e) {
                console.warn('failed to parse done event', e);
              }
            }
          }
          if (final) {
            setLast(final);
          }
          setStreaming(false);
        } else {
          const r = await api<QueryResponse>('POST', '/v1/query', req);
          setLast(r);
        }
      } catch (e) {
        const msg = e instanceof TextralApiError ? `${e.code}: ${e.message}` : (e as Error).message;
        setErr(msg);
        showToast(`Query failed: ${msg}`, 'error');
        setStreaming(false);
      } finally {
        setBusy(false);
      }
    },
    [showToast],
  );

  // Replay: load a historical query_event, hydrate the entire form
  // from its request_config, fetch the mirrored response, and remount
  // the form so the new initial takes effect.
  useEffect(() => {
    let cancelled = false;
    if (!replayId) return;
    void (async () => {
      try {
        const ev = await api<QueryEvent>('GET', `/v1/query-events/${replayId}`);
        if (cancelled) return;
        const initial = requestConfigToFormState(ev.request_config, ev.query_text);
        setReplayInitial(initial);
        setReplayMeta({
          eventId: ev.id,
          namespaceId: ev.namespace_id,
          createdAt: ev.created_at,
          degradationLevel: ev.degradation_level,
          latencyMs: ev.latency_ms,
        });
        setFormKey(`replay-${ev.id}`);
        setErr(null);

        // Fetch the mirrored QueryResponse so the right pane shows
        // the historical answer/citations/audit. 410 means the row
        // exists but the mirror is gone — surface a friendly note
        // and keep the right pane empty.
        try {
          const historical = await api<QueryResponse>(
            'GET',
            `/v1/query-events/${ev.id}/response`,
          );
          if (cancelled) return;
          setLast(historical);
          setLastIsHistorical(true);
          setReplayResponseStatus({ available: true });
        } catch (e) {
          if (cancelled) return;
          setLast(null);
          setLastIsHistorical(false);
          if (e instanceof TextralApiError && e.status === 410) {
            const reason =
              (e.details as { reason?: string } | undefined)?.reason ?? 'unavailable';
            setReplayResponseStatus({
              available: false,
              reason,
              detail: e.message,
            });
          } else {
            const detail = e instanceof Error ? e.message : String(e);
            setReplayResponseStatus({
              available: false,
              reason: 'fetch_error',
              detail,
            });
          }
        }

        showToast(`Replay loaded · ${ev.id.slice(0, 16)}…`, 'info');
        // Clear the search param so a refresh doesn't re-trigger.
        const next = new URLSearchParams(searchParams);
        next.delete('replay');
        setSearchParams(next, { replace: true });
      } catch (e) {
        const msg = e instanceof TextralApiError ? `${e.code}: ${e.message}` : (e as Error).message;
        showToast(`Replay failed: ${msg}`, 'error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [replayId, showToast, searchParams, setSearchParams]);

  function clearReplay() {
    setReplayInitial(null);
    setReplayMeta(null);
    setReplayResponseStatus(null);
    setLast(null);
    setLastIsHistorical(false);
    setFormKey(`fresh-${Date.now()}`);
  }

  const candidates = useMemo(() => {
    if (!last) return [];
    // Backend follow-up flagged in design Step 23.2: candidates aren't yet
    // exposed in /v1/query response. Surface only the citations as a
    // best-effort 'made-the-cut' view in the meantime.
    return last.citations.map((c, idx) => ({
      rank: idx + 1,
      chunk_id: c.chunk_id,
      section_path: c.section_path,
      dense_score: null,
      sparse_score: null,
      rrf: null,
      cited: true,
    }));
  }, [last]);

  if (!active) {
    return (
      <div style={pageStyle}>
        <EmptyState
          title="No namespace selected"
          description="Pick or create a namespace before running a query."
        />
      </div>
    );
  }

  return (
    <div style={pageStyle}>
      <PageHeader
        title="Query Bench"
        subtitle="Every input that affects retrieval lives in one form. Every output renders alongside, with the full audit one click away."
      />

      <div style={layoutStyle}>
        <div style={{ minWidth: 0 }}>
          {replayMeta && (
            <ReplayBanner
              meta={replayMeta}
              onClear={clearReplay}
            />
          )}
          <QueryForm
            key={formKey}
            onRun={(req, raw) => run(req, raw.stream)}
            busy={busy}
            {...(replayInitial ? { initial: replayInitial } : {})}
          />
        </div>
        <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: spacing.lg }}>
          {!last && !busy && !streaming && replayResponseStatus && !replayResponseStatus.available && (
            <div
              style={{
                background: colors.bgCard,
                border: `1px solid ${colors.warning}`,
                borderLeft: `3px solid ${colors.warning}`,
                borderRadius: radii.lg,
                padding: spacing.lg,
              }}
            >
              <div
                style={{
                  fontSize: 10,
                  textTransform: 'uppercase',
                  letterSpacing: '0.22em',
                  color: colors.warning,
                  fontWeight: 500,
                  marginBottom: spacing.sm,
                }}
              >
                Historical answer unavailable
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
                {explainReplayUnavailable(replayResponseStatus.reason, replayResponseStatus.detail)}
                <br />
                <br />
                The form is loaded with the historical config — hit{' '}
                <strong style={{ color: colors.textPrimary }}>Run query</strong> to re-create the
                answer with today's stack.
              </div>
            </div>
          )}

          {!last && !busy && !streaming && !(replayResponseStatus && !replayResponseStatus.available) && (
            <div
              style={{
                background: colors.bgCard,
                border: `1px dashed ${colors.borderEmphasis}`,
                borderRadius: radii.lg,
                padding: '64px 32px',
                color: colors.textMuted,
                textAlign: 'center',
                fontFamily: fonts.serif,
                fontStyle: 'italic',
                fontSize: 16,
              }}
            >
              Submit a query to see the answer, citations, and full audit.
            </div>
          )}

          {streaming && (
            <div
              style={{
                background: colors.bgCard,
                border: `1px solid ${colors.primary}`,
                borderRadius: radii.lg,
                padding: spacing.lg,
              }}
            >
              <div
                style={{
                  fontSize: 10,
                  textTransform: 'uppercase',
                  letterSpacing: '0.22em',
                  color: colors.primary,
                  marginBottom: spacing.sm,
                }}
              >
                Streaming…
              </div>
              <div
                style={{
                  fontFamily: fonts.serif,
                  fontSize: 16,
                  lineHeight: 1.65,
                  color: colors.textPrimary,
                  whiteSpace: 'pre-wrap',
                }}
              >
                {streamingText}
                <span
                  style={{
                    display: 'inline-block',
                    width: 8,
                    height: 16,
                    background: colors.primary,
                    marginLeft: 4,
                    verticalAlign: 'text-bottom',
                    animation: 'pulse-gold 1s ease-in-out infinite',
                  }}
                />
              </div>
            </div>
          )}

          {err && (
            <div
              style={{
                padding: spacing.md,
                background: 'rgba(166, 64, 56, 0.08)',
                border: `1px solid ${colors.danger}`,
                borderRadius: radii.md,
                color: colors.danger,
                fontFamily: fonts.mono,
                fontSize: 13,
              }}
            >
              {err}
            </div>
          )}

          {last && (
            <>
              <AnswerCard
                response={last}
                historical={lastIsHistorical}
                onOpenAudit={() => setDrawerOpen(true)}
                onCitationClick={(id) => setChunkOpen(id)}
              />
              <AuditTimeline audit={last.audit} />
              <RetrievalCandidates candidates={candidates} onPickChunk={(id) => setChunkOpen(id)} />
            </>
          )}
        </div>
      </div>

      {last && (
        <AnswerAuditDrawer response={last} open={drawerOpen} onClose={() => setDrawerOpen(false)} />
      )}
      {chunkOpen && <SourcePanel chunkId={chunkOpen} onClose={() => setChunkOpen(null)} />}
    </div>
  );
}

function explainReplayUnavailable(reason?: string, detail?: string): string {
  switch (reason) {
    case 'never_mirrored':
      return 'The original query failed before its answer could be mirrored — the row exists for the failed-query audit, but there\'s no answer to read back.';
    case 'mirror_error':
      return `The mirror write failed at the time: ${detail ?? 'see the row\'s mirror_error field for the underlying cause.'}`;
    case 'reaped':
      return 'The mirrored answer is no longer in blob storage (reaped or expired).';
    case 'fetch_error':
      return `Couldn't fetch the historical response: ${detail ?? 'unknown error'}.`;
    default:
      return detail ?? 'The mirrored answer is not available for this run.';
  }
}

function ReplayBanner({
  meta,
  onClear,
}: {
  meta: {
    eventId: string;
    namespaceId: string;
    createdAt: number;
    degradationLevel: string | null;
    latencyMs: number | null;
  };
  onClear: () => void;
}) {
  const variant: Parameters<typeof Badge>[0]['variant'] =
    meta.degradationLevel === 'full'
      ? 'success'
      : meta.degradationLevel === 'cannot_answer'
        ? 'danger'
        : meta.degradationLevel
          ? 'warning'
          : 'neutral';
  return (
    <div
      style={{
        background: colors.bgCard,
        border: `1px solid ${colors.primary}`,
        borderLeft: `3px solid ${colors.primary}`,
        borderRadius: radii.md,
        padding: `${spacing.sm}px ${spacing.md}px`,
        marginBottom: spacing.md,
        display: 'flex',
        alignItems: 'center',
        gap: spacing.md,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 9,
            letterSpacing: '0.30em',
            textTransform: 'uppercase',
            color: colors.primary,
            fontWeight: 600,
            marginBottom: 4,
          }}
        >
          Loaded from history
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: spacing.sm,
            flexWrap: 'wrap',
            fontSize: 12,
            color: colors.textSecondary,
            fontFamily: fonts.mono,
          }}
        >
          <code style={codeInline}>{meta.eventId}</code>
          <span style={{ color: colors.textMuted }}>·</span>
          <span>{new Date(meta.createdAt).toLocaleString()}</span>
          {meta.latencyMs != null && (
            <>
              <span style={{ color: colors.textMuted }}>·</span>
              <span>{meta.latencyMs}ms</span>
            </>
          )}
          {meta.degradationLevel && <Badge variant={variant}>{meta.degradationLevel}</Badge>}
        </div>
        <div
          style={{
            marginTop: 4,
            fontSize: 12,
            color: colors.textMuted,
            fontFamily: fonts.serif,
            fontStyle: 'italic',
          }}
        >
          Form pre-filled from this run's request_config. Tweak any field and Run to compare.
        </div>
      </div>
      <Button variant="secondary" size="sm" onClick={onClear}>
        Clear replay
      </Button>
    </div>
  );
}

const codeInline: React.CSSProperties = {
  fontFamily: fonts.mono,
  fontSize: '0.92em',
  background: colors.bgElevated,
  color: colors.accent,
  padding: '1px 6px',
  borderRadius: 3,
};

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

const pageStyle: React.CSSProperties = {
  padding: '40px 56px',
  maxWidth: 1700,
  margin: '0 auto',
  width: '100%',
};

const layoutStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(420px, 5fr) minmax(0, 7fr)',
  gap: spacing.xl,
  alignItems: 'flex-start',
};

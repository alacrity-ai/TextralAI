import { useEffect, useState } from 'react';
import { useNamespace } from '../context/NamespaceContext.js';
import { api, apiRaw, TextralApiError } from '../api/client.js';
import { readSSE } from '../api/sse.js';
import type { QueryRequest, QueryResponse } from '../api/types.js';
import { QueryForm } from '../components/QueryForm.js';
import { AnswerCard } from '../components/AnswerCard.js';
import { AuditTimeline } from '../components/AuditTimeline.js';
import { CompareDiff } from '../components/CompareDiff.js';
import { AnswerAuditDrawer } from '../components/AnswerAuditDrawer.js';
import { SourcePanel } from '../components/SourcePanel.js';
import { Button } from '../components/ui/Button.js';
import { EmptyState } from '../components/ui/EmptyState.js';
import { colors, fonts, radii, spacing } from '../styles/tokens.js';

interface PanelState {
  busy: boolean;
  err: string | null;
  response: QueryResponse | null;
  streamingText: string;
  streaming: boolean;
}

const EMPTY_PANEL: PanelState = {
  busy: false,
  err: null,
  response: null,
  streamingText: '',
  streaming: false,
};

export function Compare() {
  const { active, list } = useNamespace();
  const [a, setA] = useState<PanelState>(EMPTY_PANEL);
  const [b, setB] = useState<PanelState>(EMPTY_PANEL);
  const [nsA, setNsA] = useState<string>('');
  const [nsB, setNsB] = useState<string>('');
  const [drawer, setDrawer] = useState<'A' | 'B' | null>(null);
  const [chunkOpen, setChunkOpen] = useState<string | null>(null);

  useEffect(() => {
    if (active && !nsA) setNsA(active.slug);
    if (active && !nsB) setNsB(active.slug);
  }, [active, nsA, nsB]);

  async function runOne(req: QueryRequest, stream: boolean, set: typeof setA) {
    set((s) => ({
      ...s,
      busy: true,
      err: null,
      response: null,
      streamingText: '',
      streaming: stream,
    }));
    try {
      if (stream) {
        const res = await apiRaw('POST', '/v1/query?stream=sse', req, {
          headers: { accept: 'text/event-stream' },
        });
        if (!res.ok) throw new Error(`SSE ${res.status}: ${await res.text()}`);
        let acc = '';
        let final: QueryResponse | null = null;
        for await (const ev of readSSE(res)) {
          if (ev.event === 'token' || ev.event === 'message') {
            try {
              const payload = JSON.parse(ev.data) as { delta?: string };
              if (payload.delta) {
                acc += payload.delta;
                set((s) => ({ ...s, streamingText: acc }));
              }
            } catch {
              acc += ev.data;
              set((s) => ({ ...s, streamingText: acc }));
            }
          } else if (ev.event === 'done') {
            try {
              final = JSON.parse(ev.data) as QueryResponse;
            } catch {
              // ignore
            }
          }
        }
        set((s) => ({ ...s, busy: false, streaming: false, response: final ?? s.response }));
      } else {
        const r = await api<QueryResponse>('POST', '/v1/query', req);
        set((s) => ({ ...s, busy: false, response: r }));
      }
    } catch (e) {
      const msg = e instanceof TextralApiError ? `${e.code}: ${e.message}` : (e as Error).message;
      set((s) => ({ ...s, busy: false, err: msg, streaming: false }));
    }
  }

  if (!active || list.length === 0) {
    return (
      <div style={pageStyle}>
        <EmptyState
          title="No namespaces yet"
          description="Compare needs at least one namespace to run side-by-side queries."
        />
      </div>
    );
  }

  return (
    <div style={pageStyle}>
      <PageHeader
        title="Compare"
        subtitle="Run the same query — or two different queries — against two namespaces or two retrieval configs. Citations diff inline."
      />

      <div style={panelGrid}>
        <Panel
          letter="A"
          ns={nsA}
          onChangeNs={setNsA}
          state={a}
          onRun={(req, stream) => runOne(req, stream, setA)}
          onOpenAudit={() => setDrawer('A')}
          onChunk={setChunkOpen}
        />
        <Panel
          letter="B"
          ns={nsB}
          onChangeNs={setNsB}
          state={b}
          onRun={(req, stream) => runOne(req, stream, setB)}
          onOpenAudit={() => setDrawer('B')}
          onChunk={setChunkOpen}
        />
      </div>

      {a.response && b.response && (
        <div style={{ marginTop: spacing.xl }}>
          <CompareDiff a={a.response} b={b.response} />
        </div>
      )}

      {a.response && drawer === 'A' && (
        <AnswerAuditDrawer response={a.response} open onClose={() => setDrawer(null)} />
      )}
      {b.response && drawer === 'B' && (
        <AnswerAuditDrawer response={b.response} open onClose={() => setDrawer(null)} />
      )}
      {chunkOpen && <SourcePanel chunkId={chunkOpen} onClose={() => setChunkOpen(null)} />}
    </div>
  );
}

function Panel({
  letter,
  ns,
  onChangeNs,
  state,
  onRun,
  onOpenAudit,
  onChunk,
}: {
  letter: 'A' | 'B';
  ns: string;
  onChangeNs: (s: string) => void;
  state: PanelState;
  onRun: (req: QueryRequest, stream: boolean) => void;
  onOpenAudit: () => void;
  onChunk: (id: string) => void;
}) {
  return (
    <div style={panelStyle}>
      <div style={panelHeader}>
        <span
          aria-hidden
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 28,
            height: 28,
            borderRadius: '50%',
            background: letter === 'A' ? colors.primaryMuted : 'rgba(168, 185, 119, 0.16)',
            border: `1px solid ${letter === 'A' ? colors.primary : '#a8b977'}`,
            color: letter === 'A' ? colors.primary : '#a8b977',
            fontSize: 14,
            fontWeight: 500,
            fontFamily: fonts.mono,
          }}
        >
          {letter}
        </span>
        <span style={{ flex: 1 }} />
      </div>

      <QueryForm
        onRun={(req, raw) => onRun(req, raw.stream)}
        busy={state.busy}
        namespaceOverride={ns}
        onNamespaceChange={onChangeNs}
        hideNamespaceLabel={false}
      />

      {state.err && (
        <div
          style={{
            marginTop: spacing.md,
            padding: spacing.md,
            background: 'rgba(166, 64, 56, 0.08)',
            border: `1px solid ${colors.danger}`,
            borderRadius: radii.md,
            color: colors.danger,
            fontFamily: fonts.mono,
            fontSize: 12,
          }}
        >
          {state.err}
        </div>
      )}

      {state.streaming && (
        <div
          style={{
            marginTop: spacing.md,
            padding: spacing.md,
            background: colors.bgCard,
            border: `1px solid ${colors.primary}`,
            borderRadius: radii.lg,
            fontFamily: fonts.serif,
            fontSize: 14,
            lineHeight: 1.6,
            whiteSpace: 'pre-wrap',
            color: colors.textPrimary,
          }}
        >
          {state.streamingText}
        </div>
      )}

      {state.response && (
        <div
          style={{
            marginTop: spacing.md,
            display: 'flex',
            flexDirection: 'column',
            gap: spacing.md,
          }}
        >
          <AnswerCard
            response={state.response}
            onOpenAudit={onOpenAudit}
            onCitationClick={onChunk}
          />
          <AuditTimeline audit={state.response.audit} />
        </div>
      )}

      {!state.response && !state.busy && !state.streaming && (
        <div
          style={{
            marginTop: spacing.md,
            padding: '40px 24px',
            background: colors.bgCard,
            border: `1px dashed ${colors.borderEmphasis}`,
            borderRadius: radii.lg,
            color: colors.textMuted,
            textAlign: 'center',
            fontFamily: fonts.serif,
            fontStyle: 'italic',
            fontSize: 14,
          }}
        >
          Run panel {letter} to see its answer + diff.
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

const pageStyle: React.CSSProperties = {
  padding: '40px 56px',
  maxWidth: 1700,
  margin: '0 auto',
  width: '100%',
};

const panelGrid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: spacing.lg,
};

const panelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
};

const panelHeader: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: spacing.sm,
  marginBottom: spacing.sm,
};

// silence unused
void Button;

// Bulk-ingest panel — rendered when the user drops 2+ files into the
// existing Ingest page. Owns its own embedding / chunking form (the
// values mirror the single-file form's defaults), drives the bulk
// API end-to-end, and renders progress.

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { api, apiRaw, TextralApiError } from '../../api/client.js';
import type { ProviderName } from '../../api/types.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { Input } from '../ui/Input.js';
import { ModelSelectField } from '../ui/ModelSelectField.js';
import { ProviderKeySelectField } from '../ui/ProviderKeySelectField.js';
import { useToast } from '../../context/ToastContext.js';
import { colors, fonts, radii, spacing } from '../../styles/tokens.js';

interface BulkIngestPanelProps {
  /** Files chosen by the user. Required for fresh-upload flow;
   *  empty in resume mode (the bytes already live on the server). */
  files: File[];
  namespaceSlug: string;
  namespaceDimensions: number;
  onClear: () => void;
  /** When set, the panel skips the configuring phase and polls
   *  the given bulk job. Used by the /ingest/bulk/:id resume
   *  route. The `files` prop is ignored in this mode (we render
   *  the per-file table from the server's bulk_job_files data). */
  resumeBulkJobId?: string;
}

interface FormState {
  embedding_provider: ProviderName;
  embedding_model: string;
  embedding_provider_key_ref: string;
  chunking_profile: string;
  target_tokens: number;
  overlap_tokens: number;
  on_existing: 'skip_if_unchanged' | 'new_version' | 'replace_current';
}

const DEFAULTS: FormState = {
  embedding_provider: 'openai',
  embedding_model: 'text-embedding-3-large',
  embedding_provider_key_ref: 'default',
  chunking_profile: 'generic',
  target_tokens: 600,
  overlap_tokens: 80,
  on_existing: 'skip_if_unchanged',
};

interface BulkUploadSlot {
  ordinal: number;
  upload_url: string;
  upload_id: string;
  expires_at: number;
  method: 'PUT';
  headers: Record<string, string>;
}

interface BulkSubmitResponse {
  bulk_job_id: string;
  state: string;
  total_files: number;
  uploads: BulkUploadSlot[];
  expires_at: number;
}

interface BulkJobCounts {
  pending: number;
  uploaded: number;
  finalized: number;
  enqueued: number;
  processing: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

interface BulkJobStatus {
  bulk_job_id: string;
  state: string;
  namespace: string;
  total_files: number;
  counts: BulkJobCounts;
  progress_pct: number;
  first_failure: {
    ordinal: number;
    filename: string;
    error_code: string;
    error_detail?: string;
  } | null;
  created_at: number;
  finalized_at: number | null;
  completed_at: number | null;
  audit_query_event_filter: string;
}

interface BulkJobFile {
  ordinal: number;
  filename: string;
  size_bytes: number;
  content_type: string;
  state: string;
  document_id: string | null;
  version_id: string | null;
  ingestion_job_id: string | null;
  error_code: string | null;
  error_detail: string | null;
}

const TERMINAL_STATES = new Set(['complete', 'partial', 'failed', 'cancelled', 'expired']);

function toSameOriginPath(absoluteOrPath: string): string {
  try {
    const u = new URL(absoluteOrPath);
    return u.pathname + u.search + u.hash;
  } catch {
    return absoluteOrPath;
  }
}

function inferContentType(filename: string, declared: string): string {
  if (declared) return declared;
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'md':
    case 'markdown':
      return 'text/markdown';
    case 'txt':
      return 'text/plain';
    case 'pdf':
      return 'application/pdf';
    case 'json':
      return 'application/json';
    case 'yaml':
    case 'yml':
      return 'application/yaml';
    default:
      return 'application/octet-stream';
  }
}

export function BulkIngestPanel({
  files,
  namespaceSlug,
  namespaceDimensions,
  onClear,
  resumeBulkJobId,
}: BulkIngestPanelProps) {
  const { showToast } = useToast();
  const [form, setForm] = useState<FormState>(DEFAULTS);
  const [phase, setPhase] = useState<
    'configuring' | 'submitting' | 'uploading' | 'awaiting_confirm' | 'finalizing' | 'polling' | 'done'
  >(resumeBulkJobId ? 'polling' : 'configuring');
  const [bulkJobId, setBulkJobId] = useState<string | null>(
    resumeBulkJobId ?? null,
  );
  const [status, setStatus] = useState<BulkJobStatus | null>(null);
  const [perFile, setPerFile] = useState<BulkJobFile[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const isResumeMode = Boolean(resumeBulkJobId);

  const totalBytes = useMemo(
    () => files.reduce((s, f) => s + f.size, 0),
    [files],
  );

  // Resume an in-flight job if there's a bulk_job_id in the URL hash.
  // Skipped when explicit resumeBulkJobId is set — that prop wins.
  useEffect(() => {
    if (resumeBulkJobId) return;
    const m = window.location.hash.match(/bulk=([^&]+)/);
    if (m && !bulkJobId) {
      setBulkJobId(m[1]!);
      setPhase('polling');
    }
  }, [bulkJobId, resumeBulkJobId]);

  // When a resumed job's status arrives, infer the right phase from
  // its server-side state. This is the bridge between "we just
  // landed on /ingest/bulk/:id" and "show the user the right action
  // button." Without this, the panel sits in 'polling' forever and
  // never surfaces the Confirm button for awaiting_confirm jobs.
  useEffect(() => {
    if (!isResumeMode || !status) return;
    const allUploaded =
      status.counts.pending === 0 &&
      status.counts.uploaded > 0 &&
      status.counts.uploaded === status.total_files;
    if (status.state === 'uploading' && allUploaded) {
      setPhase('awaiting_confirm');
    } else if (TERMINAL_STATES.has(status.state)) {
      setPhase('done');
    } else if (
      status.state === 'finalizing' ||
      status.state === 'processing' ||
      status.state === 'accepted' ||
      status.state === 'uploading'
    ) {
      setPhase('polling');
    }
  }, [isResumeMode, status]);

  // Poll the bulk job until terminal.
  useEffect(() => {
    if (!bulkJobId || (phase !== 'polling' && phase !== 'finalizing')) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const s = await api<BulkJobStatus>('GET', `/v1/ingest/bulk/${bulkJobId}`);
        if (cancelled) return;
        setStatus(s);
        const f = await api<{ data: BulkJobFile[] }>(
          'GET',
          `/v1/ingest/bulk/${bulkJobId}/files?page_size=1000`,
        );
        if (cancelled) return;
        setPerFile(f.data);
        if (TERMINAL_STATES.has(s.state)) {
          setPhase('done');
        }
      } catch (e) {
        if (cancelled) return;
        setErr(e instanceof TextralApiError ? `${e.code}: ${e.message}` : (e as Error).message);
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 1500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [bulkJobId, phase]);

  function patch<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function startBulk() {
    setErr(null);
    setPhase('submitting');
    abortRef.current = new AbortController();

    try {
      // 1. Submit manifest. auto_finalize=false so the user has a
      //    confirm step (locked answer §11.2 — Sandbox uses false).
      const submitBody = {
        namespace: namespaceSlug,
        config: {
          embedding: {
            provider: form.embedding_provider,
            model: form.embedding_model,
            dimensions: namespaceDimensions,
            provider_key_ref: form.embedding_provider_key_ref,
          },
          chunking: {
            profile: form.chunking_profile,
            target_tokens: form.target_tokens,
            overlap_tokens: form.overlap_tokens,
          },
          mode: 'full' as const,
        },
        files: files.map((f, i) => ({
          ordinal: i,
          filename: f.name,
          size_bytes: f.size,
          content_type: inferContentType(f.name, f.type),
        })),
        on_existing: form.on_existing,
        auto_finalize: false,
      };
      const submit = await api<BulkSubmitResponse>('POST', '/v1/ingest/bulk', submitBody);
      setBulkJobId(submit.bulk_job_id);
      // Anchor the URL so a refresh resumes.
      window.location.hash = `bulk=${submit.bulk_job_id}`;

      // 2. Upload bytes in parallel under a concurrency cap (6).
      setPhase('uploading');
      await uploadAll(files, submit.uploads, abortRef.current.signal);

      // 3. Move to confirm-and-finalize step.
      setPhase('awaiting_confirm');
      showToast(`Uploaded ${files.length} files. Review and confirm to start ingest.`, 'info');
    } catch (e) {
      const msg = e instanceof TextralApiError ? `${e.code}: ${e.message}` : (e as Error).message;
      setErr(msg);
      setPhase('configuring');
      showToast(`Bulk submit failed: ${msg}`, 'error');
    }
  }

  async function confirmFinalize() {
    if (!bulkJobId) return;
    try {
      setPhase('finalizing');
      await api<{ ok: true }>('POST', `/v1/ingest/bulk/${bulkJobId}/finalize`);
      setPhase('polling');
      showToast('Ingest started.', 'success');
    } catch (e) {
      const msg = e instanceof TextralApiError ? `${e.code}: ${e.message}` : (e as Error).message;
      setErr(msg);
      showToast(`Finalize failed: ${msg}`, 'error');
    }
  }

  async function cancel() {
    if (!bulkJobId) return;
    try {
      await api<{ ok: true }>('DELETE', `/v1/ingest/bulk/${bulkJobId}`);
      showToast('Bulk job cancelled.', 'info');
    } catch (e) {
      const msg = e instanceof TextralApiError ? `${e.code}: ${e.message}` : (e as Error).message;
      showToast(`Cancel failed: ${msg}`, 'error');
    }
  }

  async function retryFailed() {
    if (!bulkJobId) return;
    try {
      await api<{ ok: true }>('POST', `/v1/ingest/bulk/${bulkJobId}/retry`);
      setPhase('polling');
      showToast('Retrying failed files.', 'info');
    } catch (e) {
      const msg = e instanceof TextralApiError ? `${e.code}: ${e.message}` : (e as Error).message;
      showToast(`Retry failed: ${msg}`, 'error');
    }
  }

  const reviewMode = phase === 'awaiting_confirm';
  const inFlight = phase === 'submitting' || phase === 'uploading' || phase === 'finalizing' || phase === 'polling';
  const terminal = phase === 'done';

  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div
            style={{
              fontFamily: fonts.serif,
              fontStyle: 'italic',
              fontSize: 18,
              color: colors.textPrimary,
            }}
          >
            Bulk ingest — {status?.total_files ?? files.length} files
          </div>
          <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 4 }}>
            {files.length > 0 && (
              <>{(totalBytes / 1024 / 1024).toFixed(2)} MB total · </>
            )}
            namespace{' '}
            <code style={{ fontFamily: fonts.mono }}>{namespaceSlug}</code> ·{' '}
            <code style={{ fontFamily: fonts.mono }}>{namespaceDimensions}</code>-d
            {bulkJobId && (
              <>
                {' '}· <code style={{ fontFamily: fonts.mono }}>{bulkJobId}</code>
              </>
            )}
          </div>
        </div>
        {!isResumeMode && (
          <Button onClick={onClear} disabled={inFlight && !terminal}>
            Clear
          </Button>
        )}
      </div>

      {phase === 'configuring' && (
        <div style={{ marginTop: spacing.lg, display: 'grid', gap: spacing.md, gridTemplateColumns: '1fr 1fr' }}>
          <ModelSelectField
            kind="embedding"
            label="Embedding model"
            provider={form.embedding_provider}
            value={form.embedding_model}
            onChange={(m) => patch('embedding_model', m)}
          />
          <ProviderKeySelectField
            label="Provider key"
            provider={form.embedding_provider}
            value={form.embedding_provider_key_ref}
            onChange={(v) => patch('embedding_provider_key_ref', v)}
          />
          <Input
            label="Chunking profile"
            value={form.chunking_profile}
            onChange={(e) => patch('chunking_profile', e.target.value)}
          />
          <div style={{ display: 'grid', gap: spacing.sm, gridTemplateColumns: '1fr 1fr' }}>
            <Input
              label="Target tokens"
              type="number"
              value={form.target_tokens}
              onChange={(e) => patch('target_tokens', Number(e.target.value))}
            />
            <Input
              label="Overlap tokens"
              type="number"
              value={form.overlap_tokens}
              onChange={(e) => patch('overlap_tokens', Number(e.target.value))}
            />
          </div>
          <div>
            <label style={{ fontSize: 12, color: colors.textMuted }}>On existing</label>
            <select
              value={form.on_existing}
              onChange={(e) => patch('on_existing', e.target.value as FormState['on_existing'])}
              style={{
                width: '100%',
                marginTop: 4,
                padding: '8px 12px',
                background: colors.bgInput,
                color: colors.textPrimary,
                border: `1px solid ${colors.border}`,
                borderRadius: radii.md,
                fontFamily: fonts.sans,
                fontSize: 14,
              }}
            >
              <option value="skip_if_unchanged">Skip if unchanged</option>
              <option value="new_version">New version</option>
              <option value="replace_current">Replace current</option>
            </select>
          </div>
          <div
            style={{
              gridColumn: '1 / -1',
              fontSize: 11,
              color: colors.textMuted,
              padding: '8px 12px',
              border: `1px dashed ${colors.border}`,
              borderRadius: radii.md,
              background: colors.bgSubtle,
            }}
          >
            Same embedding provider, model, and chunking applied to all{' '}
            {files.length} files. Per-file overrides aren't supported yet —{' '}
            <a
              href="https://github.com/alacrity-ai/TextralAI/blob/main/docs/development/bulk_ingest/BULK_UPLOADS_DESIGN.md"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: colors.primary }}
            >
              roadmap
            </a>
            .
          </div>
        </div>
      )}

      <BulkFileTable files={files} perFile={perFile} />

      {err && (
        <div
          style={{
            marginTop: spacing.md,
            padding: spacing.md,
            background: '#3a1010',
            color: '#ff8d8d',
            border: '1px solid #6a1d1d',
            borderRadius: radii.md,
            fontSize: 13,
          }}
        >
          {err}
        </div>
      )}

      {status && (
        <BulkProgress status={status} />
      )}

      <div style={{ display: 'flex', gap: spacing.md, marginTop: spacing.lg }}>
        {phase === 'configuring' && (
          <Button onClick={startBulk}>Upload {files.length} files</Button>
        )}
        {reviewMode && (
          <>
            <Button onClick={confirmFinalize}>Confirm — start ingest</Button>
            <Button onClick={cancel} variant="ghost">
              Cancel
            </Button>
          </>
        )}
        {(phase === 'finalizing' || phase === 'polling') && (
          <Button onClick={cancel} variant="ghost">
            Cancel
          </Button>
        )}
        {terminal && status && status.counts.failed > 0 && (
          <Button onClick={retryFailed}>Retry failed ({status.counts.failed})</Button>
        )}
        {terminal && (
          <Button onClick={onClear} variant="ghost">
            Done
          </Button>
        )}
      </div>
    </Card>
  );
}

async function uploadAll(
  files: File[],
  slots: BulkUploadSlot[],
  signal: AbortSignal,
  concurrency = 6,
): Promise<void> {
  let cursor = 0;
  async function worker() {
    while (cursor < slots.length) {
      const i = cursor++;
      if (signal.aborted) return;
      const slot = slots[i]!;
      const file = files[slot.ordinal]!;
      const path = toSameOriginPath(slot.upload_url);
      const res = await apiRaw('PUT', path, file, {
        headers: { 'content-type': inferContentType(file.name, file.type) },
      });
      if (!res.ok && res.status !== 204) {
        const text = await res.text().catch(() => '');
        throw new Error(`Upload ${file.name} failed (${res.status}): ${text}`);
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, slots.length) }, () => worker()),
  );
}

interface BulkFileTableProps {
  files: File[];
  perFile: BulkJobFile[];
}

function BulkFileTable({ files, perFile }: BulkFileTableProps) {
  const stateByOrdinal = new Map(perFile.map((f) => [f.ordinal, f]));
  // Resume-mode: no `files: File[]` in scope. Render rows from the
  // server's bulk_job_files data (which has filename + size_bytes).
  // Fresh-upload mode: zip with `files` so the table shows local
  // names even before the first poll lands.
  const rows: Array<{
    ordinal: number;
    filename: string;
    size_bytes: number;
    server: BulkJobFile | undefined;
  }> =
    files.length > 0
      ? files.map((f, i) => ({
          ordinal: i,
          filename: f.name,
          size_bytes: f.size,
          server: stateByOrdinal.get(i),
        }))
      : perFile.map((p) => ({
          ordinal: p.ordinal,
          filename: p.filename,
          size_bytes: p.size_bytes,
          server: p,
        }));
  return (
    <div
      style={{
        marginTop: spacing.lg,
        border: `1px solid ${colors.border}`,
        borderRadius: radii.md,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          background: colors.bgSubtle,
          padding: '8px 12px',
          fontSize: 11,
          fontFamily: fonts.mono,
          color: colors.textMuted,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          display: 'grid',
          gridTemplateColumns: '32px 1fr 90px 100px',
          gap: spacing.sm,
          borderBottom: `1px solid ${colors.border}`,
        }}
      >
        <div>#</div>
        <div>filename</div>
        <div>size</div>
        <div>state</div>
      </div>
      <div style={{ maxHeight: 320, overflow: 'auto' }}>
        {rows.map((r) => (
          <div
            key={r.ordinal}
            style={{
              display: 'grid',
              gridTemplateColumns: '32px 1fr 90px 100px',
              gap: spacing.sm,
              padding: '8px 12px',
              fontSize: 13,
              color: colors.textPrimary,
              fontFamily: fonts.mono,
              borderBottom: `1px solid ${colors.border}`,
            }}
            title={r.server?.error_detail ?? undefined}
          >
            <div style={{ color: colors.textMuted }}>{r.ordinal}</div>
            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {r.filename}
            </div>
            <div style={{ color: colors.textMuted }}>{(r.size_bytes / 1024).toFixed(1)} KB</div>
            <div>{stateChip(r.server?.state ?? 'pending')}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function stateChip(state: string): ReactElement {
  const colorMap: Record<string, { bg: string; fg: string }> = {
    pending: { bg: '#1a1a1a', fg: colors.textMuted },
    uploaded: { bg: '#2a1d04', fg: '#ffc93c' },
    finalized: { bg: '#2a1d04', fg: '#ffc93c' },
    enqueued: { bg: '#2a1d04', fg: '#ffc93c' },
    processing: { bg: '#2a1d04', fg: '#ffc93c' },
    succeeded: { bg: '#0c2812', fg: '#5bd16d' },
    skipped: { bg: '#1a1a1a', fg: colors.textMuted },
    failed: { bg: '#3a1010', fg: '#ff8d8d' },
  };
  const c = colorMap[state] ?? colorMap.pending!;
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        background: c.bg,
        color: c.fg,
        borderRadius: 3,
        fontSize: 11,
        letterSpacing: '0.04em',
      }}
    >
      {state}
    </span>
  );
}

function BulkProgress({ status }: { status: BulkJobStatus }) {
  return (
    <div style={{ marginTop: spacing.md }}>
      <div
        style={{
          fontSize: 11,
          color: colors.textMuted,
          marginBottom: 6,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          fontFamily: fonts.mono,
        }}
      >
        {status.state} — {status.progress_pct}%
      </div>
      <div
        style={{
          height: 6,
          background: colors.bgSubtle,
          borderRadius: 3,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${status.progress_pct}%`,
            background: colors.primary,
            transition: 'width 300ms ease',
          }}
        />
      </div>
      <div
        style={{
          marginTop: 8,
          display: 'flex',
          gap: spacing.md,
          fontSize: 12,
          fontFamily: fonts.mono,
          color: colors.textMuted,
        }}
      >
        <span style={{ color: '#5bd16d' }}>✓ {status.counts.succeeded}</span>
        <span style={{ color: '#ffc93c' }}>
          ⏳ {status.counts.processing + status.counts.enqueued + status.counts.finalized}
        </span>
        <span style={{ color: '#ff8d8d' }}>✗ {status.counts.failed}</span>
        <span>− {status.counts.skipped}</span>
      </div>
      {status.first_failure && (
        <div
          style={{
            marginTop: spacing.md,
            padding: '8px 12px',
            background: '#1a0707',
            border: '1px solid #4a1414',
            borderRadius: radii.md,
            fontSize: 12,
            fontFamily: fonts.mono,
          }}
        >
          <span style={{ color: '#ff8d8d' }}>{status.first_failure.error_code}</span>{' '}
          <span style={{ color: colors.textMuted }}>{status.first_failure.filename}</span>
          {status.first_failure.error_detail && (
            <div style={{ color: colors.textSecondary, marginTop: 4 }}>
              {status.first_failure.error_detail}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

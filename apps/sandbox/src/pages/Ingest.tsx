import { useEffect, useRef, useState } from 'react';
import { useNamespace } from '../context/NamespaceContext.js';
import { useModelRegistry } from '../context/ModelRegistryContext.js';
import { api, apiRaw, TextralApiError } from '../api/client.js';
import type {
  Document,
  FinalizeResponse,
  IngestionJobCreateResponse,
  ProviderName,
  UploadResponse,
} from '../api/types.js';
import { Button } from '../components/ui/Button.js';
import { Input } from '../components/ui/Input.js';
import { Card } from '../components/ui/Card.js';
import { EmptyState } from '../components/ui/EmptyState.js';
import { ModelSelectField } from '../components/ui/ModelSelectField.js';
import { ProviderKeySelectField } from '../components/ui/ProviderKeySelectField.js';
import { IngestStreamLog } from '../components/IngestStreamLog.js';
import { colors, fonts, radii, spacing } from '../styles/tokens.js';
import { useToast } from '../context/ToastContext.js';

// The backend returns absolute upload URLs (e.g.
// `http://localhost:8787/v1/.../data`). Strip the origin so the PUT
// stays same-origin under the Vite proxy / nginx — otherwise CORS
// blocks the preflight. Falls back to the raw string if it isn't
// parseable as a URL.
function toSameOriginPath(absoluteOrPath: string): string {
  try {
    const u = new URL(absoluteOrPath);
    return u.pathname + u.search + u.hash;
  } catch {
    return absoluteOrPath;
  }
}

interface FormState {
  title: string;
  doc_type: string;
  embedding_provider: ProviderName;
  embedding_model: string;
  embedding_dimensions: number;
  embedding_provider_key_ref: string;
  chunking_profile: string;
  target_tokens: number;
  overlap_tokens: number;
  mode: 'full' | 'embed_only' | 'enrichment_only';
}

const DEFAULTS: FormState = {
  title: '',
  doc_type: 'passage',
  embedding_provider: 'openai',
  embedding_model: 'text-embedding-3-large',
  embedding_dimensions: 1536,
  embedding_provider_key_ref: 'default',
  chunking_profile: 'generic',
  target_tokens: 600,
  overlap_tokens: 80,
  mode: 'full',
};

export function Ingest() {
  const { active } = useNamespace();
  const { showToast } = useToast();
  const registry = useModelRegistry();
  const [file, setFile] = useState<File | null>(null);
  const [form, setForm] = useState<FormState>(DEFAULTS);
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // The active namespace's `embedding_dimensions` is the hard-locked
  // dim every ingest into it must use. Sync the form whenever the
  // namespace changes — the field is rendered read-only below.
  useEffect(() => {
    if (active?.embedding_dimensions) {
      setForm((f) => ({ ...f, embedding_dimensions: active.embedding_dimensions }));
    }
  }, [active?.id, active?.embedding_dimensions]);

  function patch<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function takeFile(f: File | null) {
    setFile(f);
    if (f && !form.title) {
      const nameSansExt = f.name.replace(/\.[^/.]+$/, '').replace(/[-_]+/g, ' ');
      patch('title', nameSansExt);
    }
  }

  async function ingest() {
    if (!active) {
      setErr('No active namespace.');
      return;
    }
    if (!file) {
      setErr('Pick a file first.');
      return;
    }
    setBusy(true);
    setErr(null);
    setJobId(null);
    try {
      // 1. Register the document.
      const doc = await api<Document>('POST', `/v1/namespaces/${active.slug}/documents`, {
        title: form.title || file.name,
        doc_type: form.doc_type,
      });

      // 2. Reserve an upload slot.
      const upload = await api<UploadResponse>('POST', `/v1/documents/${doc.id}/uploads`, {
        content_type: file.type || 'text/markdown',
        size_bytes: file.size,
      });

      // 3. PUT bytes. The backend returns an absolute URL like
      // `http://localhost:8787/v1/.../data`. We strip the origin and use
      // the path portion so the request stays same-origin and routes
      // through the Vite proxy (or nginx in production) — otherwise
      // the browser preflight fails CORS against the api host.
      const uploadPath = toSameOriginPath(upload.url);
      const putRes = await apiRaw('PUT', uploadPath, file, {
        headers: { 'content-type': file.type || 'text/markdown' },
      });
      if (!putRes.ok) {
        throw new Error(`Upload PUT failed (${putRes.status}): ${await putRes.text()}`);
      }

      // 4. Finalize.
      const fin = await api<FinalizeResponse>(
        'POST',
        `/v1/documents/${doc.id}/uploads/${upload.upload_id}/finalize`,
        {},
      );

      // 5. Kick off ingest.
      const ing = await api<IngestionJobCreateResponse>('POST', `/v1/documents/${doc.id}/ingest`, {
        version_id: fin.version_id,
        embedding: {
          provider: form.embedding_provider,
          model: form.embedding_model,
          dimensions: form.embedding_dimensions,
          provider_key_ref: form.embedding_provider_key_ref,
        },
        chunking: {
          profile: form.chunking_profile,
          target_tokens: form.target_tokens,
          overlap_tokens: form.overlap_tokens,
        },
        mode: form.mode,
      });

      setJobId(ing.job_id);
      showToast(`Ingestion started: ${ing.job_id}`, 'success');
    } catch (e) {
      const msg = e instanceof TextralApiError ? `${e.code}: ${e.message}` : (e as Error).message;
      setErr(msg);
      showToast(`Ingest failed: ${msg}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  if (!active) {
    return (
      <div style={pageStyle}>
        <EmptyState
          title="No namespace selected"
          description="Pick or create a namespace before ingesting."
        />
      </div>
    );
  }

  return (
    <div style={pageStyle}>
      <PageHeader
        title="Ingest"
        subtitle={`Drop a markdown or text file into namespace ${active.slug} and watch it stream through fetch / normalize / chunk / embed / index.`}
      />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
          gap: spacing.lg,
        }}
      >
        <Card>
          <SectionLabel>Source</SectionLabel>

          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const f = e.dataTransfer.files[0];
              if (f) takeFile(f);
            }}
            onClick={() => fileInputRef.current?.click()}
            style={{
              marginTop: spacing.sm,
              border: `1px dashed ${dragOver ? colors.primary : colors.borderEmphasis}`,
              borderRadius: radii.lg,
              padding: '32px 24px',
              textAlign: 'center',
              cursor: 'pointer',
              background: dragOver ? colors.primaryMuted : colors.bgInput,
              transition: 'background 200ms ease, border-color 200ms ease',
            }}
          >
            {file ? (
              <div>
                <div style={{ color: colors.textPrimary, fontSize: 14, marginBottom: 4 }}>
                  {file.name}
                </div>
                <div style={{ color: colors.textMuted, fontSize: 11, fontFamily: fonts.mono }}>
                  {(file.size / 1024).toFixed(1)} KB · {file.type || 'unknown type'}
                </div>
              </div>
            ) : (
              <div>
                <div
                  style={{
                    fontFamily: fonts.serif,
                    fontStyle: 'italic',
                    fontSize: 16,
                    color: colors.textSecondary,
                    marginBottom: 4,
                  }}
                >
                  Drop a file here, or click to browse
                </div>
                <div style={{ fontSize: 11, color: colors.textMuted, letterSpacing: '0.05em' }}>
                  markdown · plaintext · &lt; 25 MB
                </div>
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept=".md,.markdown,.txt,text/markdown,text/plain"
              hidden
              onChange={(e) => takeFile(e.target.files?.[0] ?? null)}
            />
          </div>

          <div
            style={{
              marginTop: spacing.lg,
              display: 'flex',
              flexDirection: 'column',
              gap: spacing.md,
            }}
          >
            <Input
              label="Title"
              value={form.title}
              onChange={(e) => patch('title', e.target.value)}
              placeholder="Untitled"
            />
            <SelectField
              label="Doc type"
              value={form.doc_type}
              onChange={(v) => patch('doc_type', v)}
              options={['passage', 'reference', 'narrative', 'transcript']}
            />
            <SelectField
              label="Mode"
              value={form.mode}
              onChange={(v) => patch('mode', v as FormState['mode'])}
              options={['full', 'embed_only', 'enrichment_only']}
            />
          </div>
        </Card>

        <Card>
          <SectionLabel>Embedding</SectionLabel>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: spacing.md,
              marginTop: spacing.sm,
            }}
          >
            <SelectField
              label="Provider"
              value={form.embedding_provider}
              onChange={(v) => patch('embedding_provider', v as ProviderName)}
              options={['openai', 'cohere', 'voyage', 'workers_ai']}
            />
            <ModelSelectField
              label="Model"
              value={form.embedding_model}
              provider={form.embedding_provider}
              kind="embedding"
              onChange={(id) => {
                const known = registry.byId(id);
                setForm((f) => ({
                  ...f,
                  embedding_model: id,
                  ...(known?.dimensions ? { embedding_dimensions: known.dimensions } : {}),
                }));
              }}
            />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: spacing.md }}>
              <LockedDimensionField value={form.embedding_dimensions} />
              <ProviderKeySelectField
                label="Provider key ref"
                value={form.embedding_provider_key_ref}
                provider={form.embedding_provider}
                onChange={(v) => patch('embedding_provider_key_ref', v)}
                placeholder="default"
              />
            </div>
          </div>

          <hr className="rule" style={{ margin: `${spacing.lg}px 0` }} />

          <SectionLabel>Chunking</SectionLabel>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: spacing.md,
              marginTop: spacing.sm,
            }}
          >
            <SelectField
              label="Profile"
              value={form.chunking_profile}
              onChange={(v) => patch('chunking_profile', v)}
              options={['generic', 'narrative', 'legal', 'support_kb']}
            />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: spacing.md }}>
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
          </div>
        </Card>
      </div>

      {err && (
        <div
          style={{
            marginTop: spacing.md,
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

      <div
        style={{
          marginTop: spacing.lg,
          display: 'flex',
          justifyContent: 'flex-end',
          gap: spacing.sm,
        }}
      >
        <Button
          variant="secondary"
          onClick={() => {
            setFile(null);
            setForm(DEFAULTS);
            setJobId(null);
            setErr(null);
          }}
          disabled={busy}
        >
          Reset
        </Button>
        <Button onClick={ingest} disabled={!file || busy} loading={busy}>
          Ingest
        </Button>
      </div>

      {jobId && (
        <div style={{ marginTop: spacing.xl }}>
          <SectionLabel>Job stream</SectionLabel>
          <div style={{ marginTop: spacing.sm }}>
            <IngestStreamLog jobId={jobId} />
          </div>
        </div>
      )}
    </div>
  );
}

/** Read-only display of the namespace's locked embedding dim. The
 *  underlying form field is still updated (via the useEffect) so the
 *  ingest payload sends the right value, but the UI doesn't let the
 *  user override it — would just trip NAMESPACE_DIMENSION_MISMATCH. */
function LockedDimensionField({ value }: { value: number }) {
  return (
    <div>
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
        Dimensions
      </label>
      <div
        style={{
          padding: '11px 14px',
          background: colors.bgInput,
          border: `1px solid ${colors.border}`,
          borderRadius: radii.md,
          fontSize: 14,
          fontFamily: fonts.mono,
          color: colors.textPrimary,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span>{value}</span>
        <span
          style={{
            fontSize: 9,
            letterSpacing: '0.18em',
            color: colors.textMuted,
            textTransform: 'uppercase',
          }}
        >
          locked
        </span>
      </div>
      <div
        style={{
          marginTop: 6,
          fontSize: 11,
          color: colors.textMuted,
          fontStyle: 'italic',
          lineHeight: 1.4,
        }}
      >
        Set at namespace-create time; every ingest into this namespace must use this dim.
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 10,
        textTransform: 'uppercase',
        letterSpacing: '0.22em',
        color: colors.primary,
        fontWeight: 500,
      }}
    >
      {children}
    </div>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <div>
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
        {label}
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
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
        {options.map((o) => (
          <option key={o} value={o} style={{ background: colors.bgElevated }}>
            {o}
          </option>
        ))}
      </select>
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
  maxWidth: 1400,
  margin: '0 auto',
  width: '100%',
};

import { useEffect, useState } from 'react';
import { useNamespace } from '../context/NamespaceContext.js';
import { api, TextralApiError } from '../api/client.js';
import type { Namespace, NamespaceCreate, MeResponse, VectorBackend } from '../api/types.js';
import { Card } from '../components/ui/Card.js';
import { Input } from '../components/ui/Input.js';
import { Button } from '../components/ui/Button.js';
import { Badge } from '../components/ui/Badge.js';
import { EmptyState } from '../components/ui/EmptyState.js';
import { Spinner } from '../components/ui/Spinner.js';
import { useToast } from '../context/ToastContext.js';
import { useConfirm } from '../context/ConfirmContext.js';
import { colors, fonts, radii, spacing } from '../styles/tokens.js';

export function NamespaceList() {
  const { list, loading, refresh } = useNamespace();
  const { showToast } = useToast();
  const confirm = useConfirm();
  const [runtime, setRuntime] = useState<'cf' | 'node' | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<{
    slug: string;
    corpus_profile: string;
    default_embedding_profile: string;
    vector_backend: VectorBackend;
    vector_index_name: string;
    vector_namespace: string;
  }>({
    slug: '',
    corpus_profile: 'generic',
    default_embedding_profile: 'openai-text-embedding-3-large',
    vector_backend: 'qdrant',
    vector_index_name: '',
    vector_namespace: '',
  });

  // Detect runtime to default the vector backend correctly.
  // Step 23.2 backend follow-up: `runtime` field on /v1/me is not yet
  // surfaced. Until it lands, default to 'qdrant' (the self-host case)
  // and let the operator override.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await api<MeResponse>('GET', '/v1/me');
        if (cancelled) return;
        if (r.runtime) {
          setRuntime(r.runtime);
          setForm((f) => ({
            ...f,
            vector_backend: r.runtime === 'cf' ? 'vectorize' : 'qdrant',
          }));
        }
      } catch {
        // fall through; defaults apply
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function create() {
    if (!form.slug.trim()) return;
    setCreating(true);
    try {
      const body: NamespaceCreate = {
        slug: form.slug,
        corpus_profile: form.corpus_profile,
        default_embedding_profile: form.default_embedding_profile,
        vector_backend: form.vector_backend,
      };
      if (form.vector_backend !== 'vectorize' && form.vector_index_name.trim()) {
        body.vector_index_name = form.vector_index_name.trim();
      }
      if (form.vector_backend === 'pinecone' && form.vector_namespace.trim()) {
        body.vector_namespace = form.vector_namespace.trim();
      }
      await api<Namespace>('POST', '/v1/namespaces', body);
      showToast(`Namespace ${form.slug} created`, 'success');
      setForm((f) => ({ ...f, slug: '', vector_index_name: '', vector_namespace: '' }));
      void refresh();
    } catch (e) {
      const msg = e instanceof TextralApiError ? `${e.code}: ${e.message}` : (e as Error).message;
      showToast(`Create failed: ${msg}`, 'error');
    } finally {
      setCreating(false);
    }
  }

  async function remove(n: Namespace) {
    const ok = await confirm({
      title: `Soft-delete ${n.slug}?`,
      message: `Subsequent reads return 404. Documents and chunks remain in the database but are unreachable.`,
      danger: true,
      confirmLabel: 'Soft-delete',
    });
    if (!ok) return;
    try {
      await api('DELETE', `/v1/namespaces/${n.slug}`);
      showToast(`Soft-deleted ${n.slug}`, 'success');
      void refresh();
    } catch (e) {
      const msg = e instanceof TextralApiError ? `${e.code}: ${e.message}` : (e as Error).message;
      showToast(`Delete failed: ${msg}`, 'error');
    }
  }

  return (
    <div style={pageStyle}>
      <PageHeader
        title="Namespaces"
        subtitle="The unit of retrieval scope. Backend choice is locked at create time; switching backends needs a new namespace + re-ingest."
      />

      <Card ruled style={{ marginBottom: spacing.lg }}>
        <div style={sectionLabel}>Create namespace</div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
            gap: spacing.md,
            marginTop: spacing.md,
          }}
        >
          <Input
            label="Slug"
            value={form.slug}
            onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value }))}
            placeholder="my-corpus"
          />
          <SelectField
            label="Corpus profile"
            value={form.corpus_profile}
            onChange={(v) => setForm((f) => ({ ...f, corpus_profile: v }))}
            options={['generic', 'narrative', 'legal', 'support_kb']}
          />
          <Input
            label="Embedding profile"
            value={form.default_embedding_profile}
            onChange={(e) => setForm((f) => ({ ...f, default_embedding_profile: e.target.value }))}
          />
          <SelectField
            label="Vector backend"
            value={form.vector_backend}
            onChange={(v) => setForm((f) => ({ ...f, vector_backend: v as VectorBackend }))}
            options={['vectorize', 'qdrant', 'pinecone']}
          />
          {form.vector_backend !== 'vectorize' && (
            <Input
              label={
                form.vector_backend === 'qdrant' ? 'Qdrant collection name' : 'Pinecone host URL'
              }
              value={form.vector_index_name}
              onChange={(e) => setForm((f) => ({ ...f, vector_index_name: e.target.value }))}
              placeholder={
                form.vector_backend === 'qdrant'
                  ? 'tenant_collection_name'
                  : 'https://xxx.svc.us-east-1-aws.pinecone.io'
              }
            />
          )}
          {form.vector_backend === 'pinecone' && (
            <div>
              <Input
                label="Pinecone namespace"
                value={form.vector_namespace}
                onChange={(e) => setForm((f) => ({ ...f, vector_namespace: e.target.value }))}
                placeholder={form.slug || 'lighthouse-tales'}
              />
              <div
                style={{
                  marginTop: 6,
                  fontSize: 11,
                  color: colors.textMuted,
                  fontStyle: 'italic',
                  lineHeight: 1.4,
                }}
              >
                Pinecone partition inside the index. Many Textral namespaces can share
                one Pinecone index by varying this. Defaults to the slug.
              </div>
            </div>
          )}
        </div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginTop: spacing.md,
          }}
        >
          <span style={{ fontSize: 11, color: colors.textMuted, fontStyle: 'italic' }}>
            {runtime
              ? `runtime: ${runtime} — defaults sized accordingly`
              : 'Backend follow-up: runtime hint pending; defaults to qdrant for self-host.'}
          </span>
          <Button onClick={create} disabled={!form.slug.trim() || creating} loading={creating}>
            Create
          </Button>
        </div>
      </Card>

      {loading && (
        <div style={{ padding: spacing.xxl, display: 'flex', justifyContent: 'center' }}>
          <Spinner />
        </div>
      )}

      {!loading && list.length === 0 && (
        <EmptyState
          title="No namespaces yet"
          description="Create one above. The cookbook seeder also provisions cookbook-qdrant for you."
        />
      )}

      {!loading && list.length > 0 && (
        <div style={tableWrap}>
          <table style={tableStyle}>
            <thead>
              <tr>
                <Th>slug</Th>
                <Th>corpus profile</Th>
                <Th>embedding profile</Th>
                <Th>vector backend</Th>
                <Th>index / collection / host</Th>
                <Th>vector namespace</Th>
                <Th>created</Th>
                <Th>actions</Th>
              </tr>
            </thead>
            <tbody>
              {list.map((n) => (
                <tr key={n.id}>
                  <Td mono>{n.slug}</Td>
                  <Td>
                    <Badge variant="info">{n.corpus_profile}</Badge>
                  </Td>
                  <Td mono small>
                    {n.default_embedding_profile}
                  </Td>
                  <Td>
                    <Badge variant={n.vector_backend === 'vectorize' ? 'info' : 'success'}>
                      {n.vector_backend}
                    </Badge>
                  </Td>
                  <Td mono small>
                    {n.vector_index_name ?? '—'}
                  </Td>
                  <Td mono small>
                    {n.vector_backend === 'pinecone'
                      ? n.vector_namespace || <span style={{ color: colors.textMuted }}>(default)</span>
                      : '—'}
                  </Td>
                  <Td mono small>
                    {new Date(n.created_at).toLocaleDateString()}
                  </Td>
                  <Td>
                    <Button size="sm" variant="danger" onClick={() => remove(n)}>
                      Delete
                    </Button>
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

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: readonly string[];
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

function Th({ children }: { children?: React.ReactNode }) {
  return (
    <th
      style={{
        padding: '10px 14px',
        textAlign: 'left',
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
}: {
  children: React.ReactNode;
  mono?: boolean;
  small?: boolean;
}) {
  return (
    <td
      style={{
        padding: '12px 14px',
        fontSize: small ? 11 : 12,
        fontFamily: mono ? fonts.mono : fonts.sans,
        color: colors.textPrimary,
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

import { useEffect, useMemo, useState } from 'react';
import { useNamespace } from '../context/NamespaceContext.js';
import { useModelRegistry } from '../context/ModelRegistryContext.js';
import { Input } from './ui/Input.js';
import { Button } from './ui/Button.js';
import { colors, fonts, radii, spacing } from '../styles/tokens.js';
import type { ModelKind, ProviderName, QueryRequest } from '../api/types.js';

export interface QueryFormState {
  query: string;
  document_ids: string;
  embedding_provider: ProviderName;
  embedding_model: string;
  embedding_dimensions: number;
  embedding_provider_key_ref: string;
  inference_provider: ProviderName;
  inference_model: string;
  inference_provider_key_ref: string;
  inference_max_output_tokens: number;
  inference_temperature: number;
  retrieval_strategy: 'hybrid_rrf';
  retrieval_top_k_dense: number;
  retrieval_top_k_sparse: number;
  retrieval_rrf_k: number;
  retrieval_artifact_types: string;
  retrieval_require_citations: boolean;
  rerank_enabled: 'inherit' | 'on' | 'off';
  rerank_provider: '' | 'voyage' | 'cohere';
  rerank_model: string;
  rerank_top_n: number | '';
  rerank_provider_key_ref: string;
  context_max_tokens: number;
  prompt_system: string;
  prompt_developer: string;
  output_mode: 'text' | 'structured';
  output_schema: string;
  stream: boolean;
}

const DEFAULTS: QueryFormState = {
  query: '',
  document_ids: '',
  embedding_provider: 'openai',
  embedding_model: 'text-embedding-3-large',
  embedding_dimensions: 1536,
  embedding_provider_key_ref: 'default',
  inference_provider: 'openai',
  inference_model: 'gpt-4o-mini',
  inference_provider_key_ref: 'default',
  inference_max_output_tokens: 1024,
  inference_temperature: 0.2,
  retrieval_strategy: 'hybrid_rrf',
  retrieval_top_k_dense: 30,
  retrieval_top_k_sparse: 30,
  retrieval_rrf_k: 60,
  retrieval_artifact_types: 'passage',
  retrieval_require_citations: true,
  rerank_enabled: 'inherit',
  rerank_provider: '',
  rerank_model: '',
  rerank_top_n: '',
  rerank_provider_key_ref: '',
  context_max_tokens: 12000,
  prompt_system: '',
  prompt_developer: '',
  output_mode: 'text',
  output_schema: '',
  stream: false,
};

interface Props {
  onRun: (req: QueryRequest, raw: QueryFormState) => void;
  busy: boolean;
  initial?: Partial<QueryFormState>;
  /** When true, the namespace from the global picker is hidden from the
   *  form heading (e.g. inside Compare where each panel labels its own). */
  hideNamespaceLabel?: boolean;
  /** Override which namespace this form targets — used by Compare for the
   *  right panel. Defaults to active namespace. */
  namespaceOverride?: string;
  onNamespaceChange?: (slug: string) => void;
}

export function QueryForm({
  onRun,
  busy,
  initial,
  hideNamespaceLabel,
  namespaceOverride,
  onNamespaceChange,
}: Props) {
  const { active, list } = useNamespace();
  const registry = useModelRegistry();
  const targetNamespace = namespaceOverride ?? active?.slug ?? '';
  const storageKey = `textral.queryform.${targetNamespace || 'default'}`;
  const [form, setForm] = useState<QueryFormState>(() => {
    const saved = localStorage.getItem(storageKey);
    if (saved) {
      try {
        return { ...DEFAULTS, ...JSON.parse(saved), ...initial };
      } catch {
        // fall through
      }
    }
    return { ...DEFAULTS, ...initial };
  });

  // When the active namespace changes, prefer the profile it was actually
  // indexed under (authoritative — sourced from version_indexes server-side).
  // Fall back to the soft `default_embedding_profile` only when the namespace
  // has no ingested documents yet.
  useEffect(() => {
    if (!active) return;
    const indexed = active.indexed_profiles?.[0];
    if (indexed) {
      setForm((f) => ({
        ...f,
        embedding_provider: providerFromName(indexed.embedding_provider, f.embedding_provider),
        embedding_model: indexed.embedding_model,
        embedding_dimensions: indexed.embedding_dimensions,
      }));
    } else if (active.default_embedding_profile?.includes('text-embedding-3-large')) {
      setForm((f) => ({
        ...f,
        embedding_model: 'text-embedding-3-large',
        embedding_dimensions: 1536,
      }));
    }
    if (active.default_inference_model) {
      setForm((f) => ({
        ...f,
        inference_model: f.inference_model || active.default_inference_model!,
      }));
    }
  }, [active]);

  // Persist last-used config keyed by namespace.
  useEffect(() => {
    const { query: _q, ...rest } = form;
    localStorage.setItem(storageKey, JSON.stringify(rest));
  }, [form, storageKey]);

  const advanced = useMemo(() => false, []);
  void advanced;

  function patch<K extends keyof QueryFormState>(key: K, value: QueryFormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function buildRequest(): QueryRequest | null {
    if (!targetNamespace) return null;
    if (!form.query.trim()) return null;

    const docIds = form.document_ids
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const req: QueryRequest = {
      namespace: targetNamespace,
      query: form.query,
      embedding: {
        provider: form.embedding_provider,
        model: form.embedding_model,
        dimensions: form.embedding_dimensions,
        provider_key_ref: form.embedding_provider_key_ref,
      },
      inference: {
        provider: form.inference_provider,
        model: form.inference_model,
        provider_key_ref: form.inference_provider_key_ref,
        max_output_tokens: form.inference_max_output_tokens,
        temperature: form.inference_temperature,
      },
      retrieval: {
        strategy: form.retrieval_strategy,
        top_k_dense: form.retrieval_top_k_dense,
        top_k_sparse: form.retrieval_top_k_sparse,
        rrf_k: form.retrieval_rrf_k,
        artifact_types: form.retrieval_artifact_types
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        require_citations: form.retrieval_require_citations,
      },
      context: { max_context_tokens: form.context_max_tokens },
      prompt: {
        ...(form.prompt_system ? { system: form.prompt_system } : {}),
        ...(form.prompt_developer ? { developer: form.prompt_developer } : {}),
      },
    };

    const rerankOverride: NonNullable<NonNullable<QueryRequest['retrieval']>['rerank']> = {};
    if (form.rerank_enabled === 'on') rerankOverride.enabled = true;
    else if (form.rerank_enabled === 'off') rerankOverride.enabled = false;
    if (form.rerank_provider) rerankOverride.provider = form.rerank_provider;
    if (form.rerank_model.trim()) rerankOverride.model = form.rerank_model.trim();
    if (typeof form.rerank_top_n === 'number' && form.rerank_top_n > 0) {
      rerankOverride.top_n = form.rerank_top_n;
    }
    if (form.rerank_provider_key_ref.trim()) {
      rerankOverride.provider_key_ref = form.rerank_provider_key_ref.trim();
    }
    if (Object.keys(rerankOverride).length > 0 && req.retrieval) {
      req.retrieval.rerank = rerankOverride;
    }

    if (docIds.length > 0) {
      req.document_ids = docIds;
    }

    if (form.output_mode === 'structured' && form.output_schema.trim()) {
      try {
        req.output = { mode: 'structured', schema: JSON.parse(form.output_schema) };
      } catch {
        req.output = { mode: 'text' };
      }
    } else {
      req.output = { mode: 'text' };
    }
    return req;
  }

  const canRun = !!targetNamespace && !!form.query.trim();

  return (
    <div style={containerStyle}>
      {!hideNamespaceLabel && (
        <div style={headStyle}>
          <SectionLabel>Query</SectionLabel>
          {namespaceOverride !== undefined ? (
            <select
              value={namespaceOverride}
              onChange={(e) => onNamespaceChange?.(e.target.value)}
              style={inlineSelectStyle}
            >
              {list.map((n) => (
                <option key={n.slug} value={n.slug}>
                  {n.slug} · {n.vector_backend}
                </option>
              ))}
            </select>
          ) : (
            <span style={{ fontSize: 11, fontFamily: fonts.mono, color: colors.textMuted }}>
              ns: <span style={{ color: colors.accent }}>{active?.slug ?? '—'}</span>
            </span>
          )}
        </div>
      )}

      <textarea
        value={form.query}
        onChange={(e) => patch('query', e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            const req = buildRequest();
            if (req) onRun(req, form);
          }
        }}
        rows={4}
        placeholder="Ask anything against this namespace…"
        style={textareaStyle}
      />

      <div style={runRowStyle}>
        <label style={checkboxLabel}>
          <input
            type="checkbox"
            checked={form.stream}
            onChange={(e) => patch('stream', e.target.checked)}
          />
          <span>stream (SSE)</span>
        </label>
        <Button
          onClick={() => {
            const req = buildRequest();
            if (req) onRun(req, form);
          }}
          disabled={!canRun || busy}
          loading={busy}
          size="md"
        >
          Run query <span style={{ fontSize: 10, opacity: 0.6, marginLeft: 6 }}>⌘↵</span>
        </Button>
      </div>

      <hr className="rule" style={{ margin: `${spacing.md}px 0` }} />

      <Group title="Embedding">
        <FieldGrid>
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
            registry={registry}
            onChange={(id) => {
              const known = registry.byId(id);
              setForm((f) => ({
                ...f,
                embedding_model: id,
                ...(known?.dimensions ? { embedding_dimensions: known.dimensions } : {}),
              }));
            }}
          />
          <Input
            label="Dimensions"
            type="number"
            value={form.embedding_dimensions}
            onChange={(e) => patch('embedding_dimensions', Number(e.target.value))}
          />
          <Input
            label="Key ref"
            value={form.embedding_provider_key_ref}
            onChange={(e) => patch('embedding_provider_key_ref', e.target.value)}
          />
        </FieldGrid>
      </Group>

      <Group title="Inference">
        <FieldGrid>
          <SelectField
            label="Provider"
            value={form.inference_provider}
            onChange={(v) => patch('inference_provider', v as ProviderName)}
            options={['openai', 'anthropic', 'workers_ai']}
          />
          <ModelSelectField
            label="Model"
            value={form.inference_model}
            provider={form.inference_provider}
            kind="inference"
            registry={registry}
            onChange={(id) => patch('inference_model', id)}
          />
          <Input
            label="Key ref"
            value={form.inference_provider_key_ref}
            onChange={(e) => patch('inference_provider_key_ref', e.target.value)}
          />
          <Input
            label="Max out tokens"
            type="number"
            value={form.inference_max_output_tokens}
            onChange={(e) => patch('inference_max_output_tokens', Number(e.target.value))}
          />
          <Input
            label="Temperature"
            type="number"
            step={0.1}
            value={form.inference_temperature}
            onChange={(e) => patch('inference_temperature', Number(e.target.value))}
          />
        </FieldGrid>
      </Group>

      <Group title="Retrieval">
        <FieldGrid>
          <SelectField
            label="Strategy"
            value={form.retrieval_strategy}
            onChange={(v) => patch('retrieval_strategy', v as 'hybrid_rrf')}
            options={['hybrid_rrf']}
          />
          <Input
            label="top_k_dense"
            type="number"
            value={form.retrieval_top_k_dense}
            onChange={(e) => patch('retrieval_top_k_dense', Number(e.target.value))}
          />
          <Input
            label="top_k_sparse"
            type="number"
            value={form.retrieval_top_k_sparse}
            onChange={(e) => patch('retrieval_top_k_sparse', Number(e.target.value))}
          />
          <Input
            label="rrf_k"
            type="number"
            value={form.retrieval_rrf_k}
            onChange={(e) => patch('retrieval_rrf_k', Number(e.target.value))}
          />
          <Input
            label="artifact_types (csv)"
            value={form.retrieval_artifact_types}
            onChange={(e) => patch('retrieval_artifact_types', e.target.value)}
          />
        </FieldGrid>
        <label style={checkboxLabel}>
          <input
            type="checkbox"
            checked={form.retrieval_require_citations}
            onChange={(e) => patch('retrieval_require_citations', e.target.checked)}
          />
          <span>require citations</span>
        </label>
      </Group>

      <Group title="Reranker">
        <FieldGrid>
          <SelectField
            label="Enabled"
            value={form.rerank_enabled}
            onChange={(v) => patch('rerank_enabled', v as 'inherit' | 'on' | 'off')}
            options={['inherit', 'on', 'off']}
          />
          <SelectField
            label="Provider"
            value={form.rerank_provider}
            onChange={(v) => patch('rerank_provider', v as '' | 'voyage' | 'cohere')}
            options={['', 'voyage', 'cohere']}
          />
          <ModelSelectField
            label="Model"
            value={form.rerank_model}
            provider={form.rerank_provider === '' ? null : form.rerank_provider}
            kind="rerank"
            registry={registry}
            allowEmpty
            emptyLabel="(inherit)"
            placeholder="inherit (e.g. rerank-2.5-lite)"
            onChange={(id) => patch('rerank_model', id)}
          />
          <Input
            label="top_n"
            type="number"
            value={form.rerank_top_n === '' ? '' : form.rerank_top_n}
            onChange={(e) => {
              const v = e.target.value;
              patch('rerank_top_n', v === '' ? '' : Number(v));
            }}
            placeholder="inherit"
          />
          <Input
            label="Key ref"
            value={form.rerank_provider_key_ref}
            onChange={(e) => patch('rerank_provider_key_ref', e.target.value)}
            placeholder="inherit"
          />
        </FieldGrid>
      </Group>

      <Group title="Context & Prompt">
        <Input
          label="Max context tokens"
          type="number"
          value={form.context_max_tokens}
          onChange={(e) => patch('context_max_tokens', Number(e.target.value))}
        />
        <div style={{ marginTop: spacing.md }}>
          <FieldLabel>System prompt (optional)</FieldLabel>
          <textarea
            value={form.prompt_system}
            onChange={(e) => patch('prompt_system', e.target.value)}
            rows={2}
            placeholder="Defaults to corpus profile's system prompt…"
            style={smallTextareaStyle}
          />
        </div>
        <div style={{ marginTop: spacing.md }}>
          <FieldLabel>Developer prompt (optional)</FieldLabel>
          <textarea
            value={form.prompt_developer}
            onChange={(e) => patch('prompt_developer', e.target.value)}
            rows={2}
            placeholder="Server appends a citation suffix automatically."
            style={smallTextareaStyle}
          />
        </div>
      </Group>

      <Group title="Output">
        <SelectField
          label="Mode"
          value={form.output_mode}
          onChange={(v) => patch('output_mode', v as 'text' | 'structured')}
          options={['text', 'structured']}
        />
        {form.output_mode === 'structured' && (
          <div style={{ marginTop: spacing.sm }}>
            <FieldLabel>JSON schema</FieldLabel>
            <textarea
              value={form.output_schema}
              onChange={(e) => patch('output_schema', e.target.value)}
              rows={6}
              placeholder='{ "type": "object", "properties": { ... } }'
              style={{ ...smallTextareaStyle, fontFamily: fonts.mono, fontSize: 12 }}
            />
          </div>
        )}
      </Group>

      <Group title="Filters">
        <Input
          label="document_ids (csv, optional)"
          value={form.document_ids}
          onChange={(e) => patch('document_ids', e.target.value)}
          placeholder="doc_..., doc_..."
        />
      </Group>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details
      open
      style={{
        marginBottom: spacing.md,
        borderTop: `1px solid ${colors.border}`,
        paddingTop: spacing.md,
      }}
    >
      <summary
        style={{
          cursor: 'pointer',
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: '0.22em',
          color: colors.primary,
          fontWeight: 500,
          marginBottom: spacing.sm,
          listStyle: 'none',
        }}
      >
        {title}
      </summary>
      <div>{children}</div>
    </details>
  );
}

function FieldGrid({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
        gap: spacing.md,
      }}
    >
      {children}
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
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
      {children}
    </label>
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
      <FieldLabel>{label}</FieldLabel>
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

/** Provider+kind-filtered model picker with a free-text escape hatch.
 *  The dropdown lists curated registry entries; switching to "Custom…"
 *  reveals a text input so users can enter a model id we haven't added
 *  to the registry yet. Mirrors the registry-staleness mitigation from
 *  the solution plan. */
function ModelSelectField({
  label,
  value,
  provider,
  kind,
  registry,
  onChange,
  allowEmpty,
  emptyLabel,
  placeholder,
}: {
  label: string;
  value: string;
  provider: ProviderName | null;
  kind: ModelKind;
  registry: ReturnType<typeof useModelRegistry>;
  onChange: (id: string) => void;
  allowEmpty?: boolean;
  emptyLabel?: string;
  placeholder?: string;
}) {
  const known = useMemo(
    () => (provider ? registry.filter(provider, kind) : []),
    [registry, provider, kind],
  );
  const isKnown = value === '' || known.some((m) => m.id === value);
  const [custom, setCustom] = useState(!isKnown && value !== '');

  // If the provider changes and the current model isn't in the new
  // provider's list, leave the value alone but flip into custom mode so
  // the user sees what's set instead of a silently-mismatched dropdown.
  useEffect(() => {
    if (value === '' || known.length === 0) return;
    if (!known.some((m) => m.id === value)) setCustom(true);
  }, [known, value]);

  const selectValue = custom ? '__custom__' : value;
  const showHint = registry.loading && known.length === 0;

  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <select
        value={selectValue}
        onChange={(e) => {
          const v = e.target.value;
          if (v === '__custom__') {
            setCustom(true);
            return;
          }
          setCustom(false);
          onChange(v);
        }}
        style={modelSelectStyle}
        disabled={!provider}
      >
        {allowEmpty && (
          <option value="" style={{ background: colors.bgElevated }}>
            {emptyLabel ?? '(none)'}
          </option>
        )}
        {known.map((m) => (
          <option key={m.id} value={m.id} style={{ background: colors.bgElevated }}>
            {m.id}
            {m.tier ? ` · ${m.tier}` : ''}
          </option>
        ))}
        <option value="__custom__" style={{ background: colors.bgElevated }}>
          Custom…
        </option>
      </select>
      {custom && (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder ?? 'Type a custom model ID'}
          style={customInputStyle}
        />
      )}
      {showHint && (
        <div style={hintStyle}>Loading registry…</div>
      )}
      {!provider && (
        <div style={hintStyle}>Pick a provider first</div>
      )}
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

const containerStyle: React.CSSProperties = {
  background: colors.bgCard,
  border: `1px solid ${colors.border}`,
  borderRadius: radii.lg,
  padding: spacing.lg,
  display: 'flex',
  flexDirection: 'column',
  gap: spacing.sm,
};

const headStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: spacing.sm,
};

const textareaStyle: React.CSSProperties = {
  width: '100%',
  background: colors.bgInput,
  color: colors.textPrimary,
  border: `1px solid ${colors.border}`,
  borderRadius: radii.md,
  padding: '12px 14px',
  fontSize: 14,
  fontFamily: "'DM Sans', sans-serif",
  resize: 'vertical',
  outline: 'none',
  lineHeight: 1.55,
};

const smallTextareaStyle: React.CSSProperties = {
  width: '100%',
  background: colors.bgInput,
  color: colors.textPrimary,
  border: `1px solid ${colors.border}`,
  borderRadius: radii.md,
  padding: '10px 12px',
  fontSize: 13,
  fontFamily: "'DM Sans', sans-serif",
  resize: 'vertical',
  outline: 'none',
  lineHeight: 1.5,
};

const runRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: spacing.md,
  marginTop: spacing.sm,
};

const checkboxLabel: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 12,
  color: colors.textSecondary,
  cursor: 'pointer',
  marginTop: spacing.sm,
};

const modelSelectStyle: React.CSSProperties = {
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
};

const customInputStyle: React.CSSProperties = {
  width: '100%',
  marginTop: spacing.xs,
  background: colors.bgInput,
  color: colors.textPrimary,
  border: `1px solid ${colors.border}`,
  borderRadius: radii.md,
  padding: '10px 12px',
  fontSize: 13,
  fontFamily: fonts.mono,
  outline: 'none',
};

const hintStyle: React.CSSProperties = {
  marginTop: 6,
  fontSize: 11,
  fontFamily: fonts.mono,
  color: colors.textMuted,
};

const inlineSelectStyle: React.CSSProperties = {
  background: colors.bgInput,
  color: colors.textPrimary,
  border: `1px solid ${colors.border}`,
  borderRadius: radii.sm,
  padding: '4px 8px',
  fontSize: 12,
  fontFamily: fonts.mono,
  cursor: 'pointer',
};

/** Coerce the server-side `embedding_provider` string to the FE union type.
 *  Falls back to `current` if the value isn't one of the known providers
 *  (defensive against new providers added server-side ahead of the FE). */
function providerFromName(name: string, current: ProviderName): ProviderName {
  const known: ProviderName[] = ['openai', 'anthropic', 'cohere', 'voyage', 'workers_ai'];
  return (known as string[]).includes(name) ? (name as ProviderName) : current;
}

export const DEFAULT_QUERY_FORM = DEFAULTS;

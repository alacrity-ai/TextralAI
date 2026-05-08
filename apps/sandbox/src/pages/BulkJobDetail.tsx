// Bulk job detail / resume page. Renders BulkIngestPanel in resume
// mode — files are not in scope (they live on the server), the
// configuring phase is skipped, and the panel adapts its action
// button to whatever state the bulk_job is in.

import { useNavigate, useParams } from 'react-router-dom';
import { useNamespace } from '../context/NamespaceContext.js';
import { BulkIngestPanel } from '../components/bulk/BulkIngestPanel.js';
import { EmptyState } from '../components/ui/EmptyState.js';
import { colors, fonts, spacing } from '../styles/tokens.js';

export function BulkJobDetail() {
  const { id } = useParams<{ id: string }>();
  const { active } = useNamespace();
  const navigate = useNavigate();

  if (!active) {
    return (
      <div style={pageStyle}>
        <EmptyState
          title="No namespace selected"
          description="Pick or create a namespace to view bulk job detail."
        />
      </div>
    );
  }
  if (!id) {
    return (
      <div style={pageStyle}>
        <EmptyState title="Missing bulk job id" description="Use a link from /ingest/bulk." />
      </div>
    );
  }

  return (
    <div style={pageStyle}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <PageHeader
          title="Bulk job"
          subtitle="Resume, confirm, retry failed files, or cancel — depending on current state."
        />
        <button
          type="button"
          onClick={() => navigate('/ingest/bulk')}
          style={{
            marginTop: 12,
            fontSize: 11,
            color: colors.textMuted,
            background: 'transparent',
            cursor: 'pointer',
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
            fontFamily: "'DM Sans', sans-serif",
            border: `1px solid ${colors.border}`,
            borderRadius: 4,
            padding: '8px 14px',
            whiteSpace: 'nowrap',
          }}
        >
          ← Back to bulk jobs
        </button>
      </div>

      <BulkIngestPanel
        files={[]}
        namespaceSlug={active.slug}
        namespaceDimensions={active.embedding_dimensions}
        onClear={() => navigate('/ingest/bulk')}
        resumeBulkJobId={id}
      />
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
  maxWidth: 1500,
  margin: '0 auto',
};

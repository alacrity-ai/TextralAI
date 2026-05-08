import { Link, useLocation } from 'react-router-dom';
import { useState } from 'react';
import { colors, fonts } from '../../styles/tokens.js';
import { useApiKey } from '../../auth/ApiKeyContext.js';
import { useActiveJobs } from '../../context/ActiveJobsContext.js';
import { useBulkJobsActive } from '../../context/BulkJobsActiveContext.js';
import { NamespacePicker } from '../NamespacePicker.js';
import { apiUrl } from '../../api/client.js';

const NAV_LINKS: Array<{ to: string; label: string }> = [
  { to: '/', label: 'Query' },
  { to: '/history', label: 'History' },
  { to: '/ingest', label: 'Ingest' },
  { to: '/compare', label: 'Compare' },
  { to: '/namespaces', label: 'Namespaces' },
  { to: '/documents', label: 'Documents' },
  { to: '/provider-keys', label: 'Keys' },
  { to: '/admin', label: 'Admin' },
];

export function Navbar() {
  const location = useLocation();
  const { setKey } = useApiKey();
  const activeJobs = useActiveJobs();
  const bulkJobs = useBulkJobsActive();
  const [menuOpen, setMenuOpen] = useState(false);

  // Count only non-terminal jobs for the badge — once a job hits
  // completed/failed (incl. cancelled) it's no longer "active" even if
  // it's still in the grace-window list. Combines single-file ingests
  // (ActiveJobsContext) with bulk jobs (BulkJobsActiveContext) so the
  // tab signals "something is happening on Ingest" regardless of
  // which path the user used.
  const singleIngestCount = activeJobs.jobs.filter((j) => j.terminalAt === null).length;
  const ingestBadgeCount = singleIngestCount + bulkJobs.inFlightCount;

  const isActive = (to: string) =>
    to === '/' ? location.pathname === '/' : location.pathname.startsWith(to);

  return (
    <nav
      style={{
        height: 64,
        background: 'rgba(19, 17, 15, 0.78)',
        backdropFilter: 'blur(14px) saturate(140%)',
        WebkitBackdropFilter: 'blur(14px) saturate(140%)',
        borderBottom: `1px solid ${colors.border}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 32px',
        position: 'sticky',
        top: 0,
        zIndex: 100,
      }}
    >
      <div
        aria-hidden
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: -1,
          height: 1,
          background: `linear-gradient(to right, transparent 0%, ${colors.hairline} 30%, ${colors.hairline} 70%, transparent 100%)`,
          pointerEvents: 'none',
        }}
      />

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 32 }}>
        <Link
          to="/"
          aria-label="Textral Sandbox home"
          style={{ display: 'flex', alignItems: 'baseline', gap: 9, textDecoration: 'none' }}
        >
          <span
            style={{
              fontFamily: fonts.display,
              fontWeight: 400,
              fontSize: 22,
              letterSpacing: '-0.025em',
              color: colors.textPrimary,
              fontVariationSettings: '"opsz" 144, "SOFT" 30',
              lineHeight: 1,
            }}
          >
            Textral
          </span>
          <span
            aria-hidden
            style={{
              display: 'inline-block',
              width: 8,
              height: 1,
              background: colors.primary,
              transform: 'translateY(-6px)',
              opacity: 0.8,
            }}
          />
          <span
            style={{
              fontFamily: fonts.sans,
              fontSize: 9,
              fontWeight: 600,
              letterSpacing: '0.30em',
              color: colors.primary,
              textTransform: 'uppercase',
              transform: 'translateY(-2px)',
            }}
          >
            Sandbox
          </span>
        </Link>

        {NAV_LINKS.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            label={link.label}
            active={isActive(link.to)}
            {...(link.to === '/ingest' && ingestBadgeCount > 0
              ? { badge: ingestBadgeCount }
              : {})}
          />
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <NamespacePicker />
        <div style={{ position: 'relative' }}>
          <button
            onClick={() => setMenuOpen((o) => !o)}
            onBlur={() => setTimeout(() => setMenuOpen(false), 200)}
            aria-label="Open key menu"
            style={{
              padding: '6px 10px',
              fontSize: 14,
              background: 'transparent',
              color: colors.textMuted,
              border: `1px solid ${colors.border}`,
              borderRadius: 4,
              cursor: 'pointer',
              transition: 'color 200ms ease, border-color 200ms ease',
            }}
          >
            ⋯
          </button>
          {menuOpen && (
            <div
              style={{
                position: 'absolute',
                top: '100%',
                right: 0,
                marginTop: 6,
                minWidth: 220,
                background: colors.bgElevated,
                border: `1px solid ${colors.border}`,
                borderRadius: 6,
                boxShadow: '0 12px 32px rgba(0,0,0,0.55)',
                zIndex: 200,
                overflow: 'hidden',
              }}
            >
              <MenuItem
                label="API reference (/docs)"
                onClick={() => window.open(apiUrl('/docs'), '_blank', 'noopener,noreferrer')}
              />
              <MenuItem
                label="OpenAPI spec (/openapi.json)"
                onClick={() => window.open(apiUrl('/openapi.json'), '_blank', 'noopener,noreferrer')}
              />
              <div style={{ height: 1, background: colors.border }} />
              <MenuItem
                label="Forget API key"
                danger
                onClick={() => {
                  setKey(null);
                  setMenuOpen(false);
                }}
              />
            </div>
          )}
        </div>
      </div>
    </nav>
  );
}

function MenuItem({
  label,
  onClick,
  danger,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '10px 14px',
        fontSize: 13,
        background: hover ? colors.bgCard : 'transparent',
        color: danger ? colors.danger : hover ? colors.textPrimary : colors.textSecondary,
        border: 'none',
        cursor: 'pointer',
        fontFamily: "'DM Sans', sans-serif",
      }}
    >
      {label}
    </button>
  );
}

function NavLink({
  to,
  label,
  active,
  badge,
}: {
  to: string;
  label: string;
  active: boolean;
  badge?: number;
}) {
  return (
    <Link to={to} style={{ textDecoration: 'none', padding: '4px 0', cursor: 'pointer' }}>
      <span
        style={{
          position: 'relative',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 11,
          fontWeight: 500,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: active ? colors.textPrimary : colors.textMuted,
          transition: 'color 200ms ease',
          paddingBottom: 4,
        }}
      >
        {label}
        {badge !== undefined && badge > 0 && (
          <span
            aria-label={`${badge} active job${badge === 1 ? '' : 's'}`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              minWidth: 16,
              height: 16,
              padding: '0 5px',
              fontSize: 9,
              fontWeight: 600,
              letterSpacing: '0.04em',
              background: colors.primary,
              color: colors.bgBase,
              borderRadius: 999,
              animation: 'pulse-gold 1.4s ease-in-out infinite',
            }}
          >
            {badge}
          </span>
        )}
        <span
          aria-hidden
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: -2,
            height: 1,
            background: colors.primary,
            transform: active ? 'scaleX(1)' : 'scaleX(0)',
            transformOrigin: 'left',
            transition: 'transform 260ms cubic-bezier(0.2, 0.6, 0.2, 1)',
          }}
        />
      </span>
    </Link>
  );
}

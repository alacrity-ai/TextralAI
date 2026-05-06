import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { colors, radii, spacing } from '../styles/tokens.js';
import { Button } from '../components/ui/Button.js';

export interface ConfirmOptions {
  title?: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

type Resolver = (value: boolean) => void;

interface ConfirmContextValue {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

export function useConfirm(): ConfirmContextValue['confirm'] {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used inside ConfirmProvider');
  return ctx.confirm;
}

interface PendingState {
  opts: ConfirmOptions;
  resolve: Resolver;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingState | null>(null);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);

  const confirm = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setPending({ opts, resolve });
      }),
    [],
  );

  const close = useCallback(
    (value: boolean) => {
      if (!pending) return;
      pending.resolve(value);
      setPending(null);
    },
    [pending],
  );

  useEffect(() => {
    if (!pending) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(false);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        close(true);
      }
    };
    window.addEventListener('keydown', handler);
    const t = setTimeout(() => confirmBtnRef.current?.focus(), 30);
    return () => {
      window.removeEventListener('keydown', handler);
      clearTimeout(t);
    };
  }, [pending, close]);

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      {pending && (
        <>
          <div onClick={() => close(false)} style={backdropStyle} />
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            style={dialogStyle}
          >
            {pending.opts.title && (
              <h3 id="confirm-title" style={titleStyle}>
                {pending.opts.title}
              </h3>
            )}
            <div style={messageStyle}>{pending.opts.message}</div>
            <div style={footerStyle}>
              <Button variant="secondary" onClick={() => close(false)}>
                {pending.opts.cancelLabel ?? 'Cancel'}
              </Button>
              <button
                ref={confirmBtnRef}
                onClick={() => close(true)}
                style={{
                  ...confirmBaseStyle,
                  background: pending.opts.danger ? colors.danger : colors.primary,
                }}
              >
                {pending.opts.confirmLabel ?? (pending.opts.danger ? 'Delete' : 'Confirm')}
              </button>
            </div>
          </div>
        </>
      )}
    </ConfirmContext.Provider>
  );
}

const backdropStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.55)',
  zIndex: 600,
  animation: 'page-fade-in 120ms ease-out',
};

const dialogStyle: React.CSSProperties = {
  position: 'fixed',
  top: '35%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  width: 'min(440px, 92vw)',
  zIndex: 601,
  background: colors.bgCard,
  border: `1px solid ${colors.border}`,
  borderRadius: radii.lg,
  boxShadow: '0 24px 60px rgba(0,0,0,0.7)',
  padding: spacing.lg,
  display: 'flex',
  flexDirection: 'column',
  gap: spacing.md,
};

const titleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 17,
  fontWeight: 500,
  color: colors.textPrimary,
};

const messageStyle: React.CSSProperties = {
  fontSize: 14,
  color: colors.textSecondary,
  lineHeight: 1.55,
};

const footerStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: spacing.sm,
  marginTop: spacing.xs,
};

const confirmBaseStyle: React.CSSProperties = {
  color: '#1a1208',
  border: 'none',
  borderRadius: radii.md,
  padding: '8px 16px',
  fontSize: 14,
  fontWeight: 500,
  cursor: 'pointer',
};

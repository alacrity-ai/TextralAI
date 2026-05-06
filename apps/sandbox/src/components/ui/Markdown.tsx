import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { colors } from '../../styles/tokens.js';

export function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <p style={{ margin: '0 0 12px', color: 'inherit' }}>{children}</p>,
        strong: ({ children }) => (
          <strong style={{ color: colors.textPrimary, fontWeight: 600 }}>{children}</strong>
        ),
        em: ({ children }) => <em style={{ fontStyle: 'italic' }}>{children}</em>,
        del: ({ children }) => <del style={{ color: colors.textMuted }}>{children}</del>,
        h1: ({ children }) => (
          <h1
            style={{
              fontSize: '1.6em',
              fontWeight: 700,
              margin: '24px 0 12px',
              color: colors.textPrimary,
            }}
          >
            {children}
          </h1>
        ),
        h2: ({ children }) => (
          <h2
            style={{
              fontSize: '1.35em',
              fontWeight: 700,
              margin: '20px 0 10px',
              color: colors.textPrimary,
            }}
          >
            {children}
          </h2>
        ),
        h3: ({ children }) => (
          <h3
            style={{
              fontSize: '1.15em',
              fontWeight: 600,
              margin: '16px 0 8px',
              color: colors.textPrimary,
            }}
          >
            {children}
          </h3>
        ),
        h4: ({ children }) => (
          <h4
            style={{
              fontSize: '1em',
              fontWeight: 600,
              margin: '14px 0 6px',
              color: colors.textPrimary,
            }}
          >
            {children}
          </h4>
        ),
        ul: ({ children }) => <ul style={{ paddingLeft: 24, margin: '0 0 12px' }}>{children}</ul>,
        ol: ({ children }) => <ol style={{ paddingLeft: 24, margin: '0 0 12px' }}>{children}</ol>,
        li: ({ children }) => <li style={{ marginBottom: 4 }}>{children}</li>,
        blockquote: ({ children }) => (
          <blockquote
            style={{
              borderLeft: `3px solid ${colors.borderEmphasis}`,
              paddingLeft: 12,
              margin: '8px 0',
              color: colors.textMuted,
              fontStyle: 'italic',
            }}
          >
            {children}
          </blockquote>
        ),
        hr: () => (
          <hr
            style={{ border: 'none', borderTop: `1px solid ${colors.border}`, margin: '16px 0' }}
          />
        ),
        a: ({ children, href }) => (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: colors.accent, textDecoration: 'underline' }}
          >
            {children}
          </a>
        ),
        code: ({ children, className }) => {
          const isBlock = className?.includes('language-');
          if (isBlock) {
            return (
              <code
                className={className}
                style={{
                  fontFamily:
                    "'JetBrains Mono', SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                  fontSize: '0.9em',
                  color: colors.accent,
                }}
              >
                {children}
              </code>
            );
          }
          return (
            <code
              style={{
                fontFamily: "'JetBrains Mono', SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                background: colors.bgElevated,
                color: colors.accent,
                padding: '2px 6px',
                borderRadius: 4,
                fontSize: '0.88em',
              }}
            >
              {children}
            </code>
          );
        },
        pre: ({ children }) => (
          <pre
            style={{
              background: colors.bgElevated,
              padding: 12,
              borderRadius: 6,
              overflow: 'auto',
              margin: '8px 0',
              fontFamily: "'JetBrains Mono', SFMono-Regular, Menlo, Monaco, Consolas, monospace",
              fontSize: '0.9em',
              lineHeight: 1.5,
              whiteSpace: 'pre',
            }}
          >
            {children}
          </pre>
        ),
        table: ({ children }) => (
          <table style={{ borderCollapse: 'collapse', margin: '12px 0', fontSize: '0.95em' }}>
            {children}
          </table>
        ),
        th: ({ children }) => (
          <th
            style={{
              border: `1px solid ${colors.border}`,
              padding: '6px 10px',
              background: colors.bgElevated,
              textAlign: 'left',
            }}
          >
            {children}
          </th>
        ),
        td: ({ children }) => (
          <td style={{ border: `1px solid ${colors.border}`, padding: '6px 10px' }}>{children}</td>
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  );
}

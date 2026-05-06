import { useEffect } from 'react';

// Map keys like 'mod+k', 'mod+/', 'esc', '?'.
// 'mod' normalizes to ⌘ on Mac, Ctrl elsewhere.
type Handler = (e: KeyboardEvent) => void;

const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);

function match(binding: string, e: KeyboardEvent): boolean {
  const parts = binding
    .toLowerCase()
    .split('+')
    .map((s) => s.trim());
  const key = parts.pop()!;
  const needMod = parts.includes('mod');
  const needShift = parts.includes('shift');
  const needAlt = parts.includes('alt');

  if (needMod !== (isMac ? e.metaKey : e.ctrlKey)) return false;
  if (needShift !== e.shiftKey) return false;
  if (needAlt !== e.altKey) return false;
  if (e.key.toLowerCase() !== key) return false;
  return true;
}

export function useHotkeys(map: Record<string, Handler>, opts?: { enabled?: boolean }) {
  useEffect(() => {
    if (opts?.enabled === false) return;
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const inEditable =
        tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable;

      for (const [binding, fn] of Object.entries(map)) {
        if (match(binding, e)) {
          if (inEditable && !binding.includes('mod+') && binding !== 'escape') continue;
          fn(e);
          break;
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [map, opts?.enabled]);
}

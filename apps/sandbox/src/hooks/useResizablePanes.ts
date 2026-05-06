import { useCallback, useEffect, useRef, useState } from 'react';

// Drag-to-resize for a 3-pane layout. Persists widths to localStorage.
export function useResizablePanes({
  storageKey,
  defaultLeft,
  defaultRight,
  minLeft = 160,
  maxLeft = 400,
  minRight = 260,
  maxRight = 560,
}: {
  storageKey: string;
  defaultLeft: number;
  defaultRight: number;
  minLeft?: number;
  maxLeft?: number;
  minRight?: number;
  maxRight?: number;
}) {
  const [left, setLeft] = useState<number>(() => {
    const raw = localStorage.getItem(`${storageKey}.left`);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) ? Math.min(maxLeft, Math.max(minLeft, n)) : defaultLeft;
  });
  const [right, setRight] = useState<number>(() => {
    const raw = localStorage.getItem(`${storageKey}.right`);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) ? Math.min(maxRight, Math.max(minRight, n)) : defaultRight;
  });
  const draggingRef = useRef<null | 'left' | 'right'>(null);
  const startXRef = useRef(0);
  const startLeftRef = useRef(0);
  const startRightRef = useRef(0);

  useEffect(() => {
    localStorage.setItem(`${storageKey}.left`, String(left));
  }, [left, storageKey]);
  useEffect(() => {
    localStorage.setItem(`${storageKey}.right`, String(right));
  }, [right, storageKey]);

  const onMove = useCallback(
    (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const dx = e.clientX - startXRef.current;
      if (draggingRef.current === 'left') {
        const next = startLeftRef.current + dx;
        setLeft(Math.min(maxLeft, Math.max(minLeft, next)));
      } else {
        const next = startRightRef.current - dx;
        setRight(Math.min(maxRight, Math.max(minRight, next)));
      }
    },
    [minLeft, maxLeft, minRight, maxRight],
  );

  const onUp = useCallback(() => {
    draggingRef.current = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  useEffect(() => {
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [onMove, onUp]);

  const startDrag = (which: 'left' | 'right') => (e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = which;
    startXRef.current = e.clientX;
    startLeftRef.current = left;
    startRightRef.current = right;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  return { left, right, setLeft, setRight, startDrag };
}

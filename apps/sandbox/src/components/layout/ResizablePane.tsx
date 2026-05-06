import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { colors } from '../../styles/tokens.js';

interface Props {
  leftPercent: number;
  onResize: (percent: number) => void;
  minLeftPx?: number;
  minRightPx?: number;
  left: ReactNode;
  right: ReactNode;
  style?: React.CSSProperties;
}

export function ResizablePane({
  leftPercent,
  onResize,
  minLeftPx = 320,
  minRightPx = 320,
  left,
  right,
  style,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(true);
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const c = containerRef.current;
      if (!c) return;
      const rect = c.getBoundingClientRect();
      const relX = e.clientX - rect.left;
      let percent = (relX / rect.width) * 100;
      const minLeft = (minLeftPx / rect.width) * 100;
      const maxLeft = 100 - (minRightPx / rect.width) * 100;
      percent = Math.max(minLeft, Math.min(maxLeft, percent));
      onResize(percent);
    };
    const onUp = () => setDragging(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [dragging, minLeftPx, minRightPx, onResize]);

  return (
    <div
      ref={containerRef}
      style={{ display: 'flex', height: '100%', position: 'relative', ...style }}
    >
      <div
        style={{ width: `${leftPercent}%`, minWidth: 0, display: 'flex', flexDirection: 'column' }}
      >
        {left}
      </div>
      <div
        onMouseDown={onMouseDown}
        style={{
          width: 4,
          cursor: 'col-resize',
          background: dragging ? colors.primary : colors.border,
          transition: dragging ? 'none' : 'background 0.15s',
          flexShrink: 0,
        }}
        aria-label="Resize pane"
        role="separator"
      />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>{right}</div>
    </div>
  );
}

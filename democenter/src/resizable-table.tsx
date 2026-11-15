import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent, ReactNode } from 'react';

export type ResizableColumn = { label: string; initial: number; min: number };

function loadWidths(columns: readonly ResizableColumn[], storageKey: string): number[] {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    if (Array.isArray(saved) && saved.length === columns.length && saved.every((width, index) => Number.isInteger(width) && width >= columns[index].min && width <= 800)) return saved;
  } catch { /* Use the defaults if browser storage is unavailable. */ }
  return columns.map(column => column.initial);
}

export function ResizableTable({ columns, storageKey, children }: { columns: readonly ResizableColumn[]; storageKey: string; children: ReactNode }) {
  const [widths, setWidths] = useState(() => loadWidths(columns, storageKey));
  const drag = useRef<{ index: number; startX: number; startWidth: number } | null>(null);
  useEffect(() => { try { localStorage.setItem(storageKey, JSON.stringify(widths)); } catch { /* Resizing still works without storage. */ } }, [storageKey, widths]);

  function resize(index: number, width: number) {
    setWidths(current => current.map((value, at) => at === index ? Math.max(columns[index].min, Math.min(800, Math.round(width))) : value));
  }
  function start(index: number, event: PointerEvent<HTMLSpanElement>) {
    event.preventDefault();
    drag.current = { index, startX: event.clientX, startWidth: event.currentTarget.parentElement?.getBoundingClientRect().width ?? widths[index] };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function move(event: PointerEvent<HTMLSpanElement>) {
    if (drag.current) resize(drag.current.index, drag.current.startWidth + event.clientX - drag.current.startX);
  }
  function finish(event: PointerEvent<HTMLSpanElement>) {
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function keyResize(index: number, event: KeyboardEvent<HTMLSpanElement>) {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      resize(index, widths[index] + (event.key === 'ArrowRight' ? 10 : -10));
    }
  }

  return <table className="resizable-table" style={{ minWidth: `${widths.reduce((sum, width) => sum + width, 0)}px` }}>
    <colgroup>{widths.map((width, index) => <col key={columns[index].label} style={{ width }} />)}</colgroup>
    <thead><tr>{columns.map((column, index) => <th key={column.label}>{column.label}<span className="column-resize-handle" role="separator" tabIndex={0} aria-orientation="vertical" aria-label={`调整${column.label}列宽`} aria-valuenow={widths[index]} aria-valuemin={column.min} aria-valuemax={800} title="拖动调整列宽，双击恢复默认" onPointerDown={event => start(index, event)} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish} onKeyDown={event => keyResize(index, event)} onDoubleClick={() => resize(index, column.initial)} /></th>)}</tr></thead>
    {children}
  </table>;
}

import { useEffect, useRef } from 'react';
import type { TerminalLogLine } from './types.js';

interface Props {
  lines: TerminalLogLine[];
  onClose: () => void;
}

function formatTs(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export default function TerminalPanel({ lines, onClose }: Props) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

  // Track whether the user has scrolled up — if so, stop auto-following so we
  // don't yank them away from a line they're inspecting.
  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = dist < 8;
  };

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div className="terminalPanel" role="log" aria-live="polite" aria-label="Backend log output">
      <div className="terminalPanelHeader">
        <span className="terminalPanelTitle">TERMINAL</span>
        <span className="terminalPanelMeta">{lines.length} lines</span>
        <button
          className="terminalPanelClose"
          onClick={onClose}
          aria-label="Close terminal"
          title="Close terminal"
        >
          ×
        </button>
      </div>
      <div className="terminalPanelBody" ref={scrollerRef} onScroll={onScroll}>
        {lines.length === 0 ? (
          <div className="terminalPanelEmpty">waiting for output…</div>
        ) : (
          lines.map((l, i) => (
            <div
              key={i}
              className={`terminalLine${l.level === 'error' ? ' terminalLine--err' : ''}`}
            >
              <span className="terminalLineTs">{formatTs(l.ts)}</span>
              <span className="terminalLineText">{l.text}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

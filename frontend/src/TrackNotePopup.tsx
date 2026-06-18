import type { DeckNumber } from './types.js';

interface Props {
  deck: DeckNumber;
  fileName: string;
  title: string;
  artist: string;
  description: string;
  onDismiss: () => void;
}

export default function TrackNotePopup({ deck, fileName, title, artist, description, onDismiss }: Props) {
  const headerLine =
    title || artist
      ? [artist, title].filter(Boolean).join(' — ')
      : fileName;

  return (
    <div className="modalBackdrop" onClick={onDismiss} role="dialog" aria-modal="true">
      <div
        className={`modalDialog trackNoteDialog theme-d${deck}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modalHeader">
          <div className="modalTitle">
            Note · Deck {deck}
            <span className="modalTitleUser">{headerLine}</span>
          </div>
          <button className="modalClose" onClick={onDismiss} aria-label="Dismiss">×</button>
        </div>
        <div className="modalBody">
          <div className="trackNoteText">{description}</div>
        </div>
      </div>
    </div>
  );
}

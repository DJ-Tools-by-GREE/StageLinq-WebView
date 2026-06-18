import { useRef, useState } from 'react';
import type { CsvSong } from '../editorTypes.js';
import { DEFAULT_OFFSET_INCREMENT, DEFAULT_OFFSET_START } from '../defaults.js';
import { parseCSV } from '../utils/csv.js';
import { secToHMS } from '../utils/format.js';

interface Props {
  lastOffsetSec: number | null;
  onImport: (songs: CsvSong[], startOffset: number, increment: number) => void;
  onClose: () => void;
}

export function CsvImportModal({ lastOffsetSec, onImport, onClose }: Props) {
  const [songs, setSongs] = useState<CsvSong[]>([]);
  const [startOffset, setStartOffset] = useState(
    lastOffsetSec !== null ? lastOffsetSec + DEFAULT_OFFSET_INCREMENT : DEFAULT_OFFSET_START
  );
  const [increment, setIncrement] = useState(DEFAULT_OFFSET_INCREMENT);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const parsed = parseCSV(ev.target?.result as string);
        setSongs(parsed);
        setError('');
      } catch {
        setError('Failed to parse CSV. Make sure it is a valid Engine DJ export.');
      }
    };
    reader.readAsText(file);
  };

  return (
    <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <div className="modal-header">
          <h2>Import from CSV</h2>
          <button className="btn-icon" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          <div className="import-controls">
            <label className="file-label">
              <span>CSV File</span>
              <input
                ref={fileRef}
                type="file"
                accept=".csv"
                onChange={handleFile}
                className="file-input"
              />
              <button className="btn btn-secondary" onClick={() => fileRef.current?.click()}>
                Choose CSV…
              </button>
              <span className="file-name-hint">
                {fileRef.current?.files?.[0]?.name ?? 'No file chosen'}
              </span>
            </label>

            <div className="import-offset-row">
              <label>
                Start Offset (sec)
                <span className="hms-badge">{secToHMS(startOffset)}</span>
                <input
                  type="number"
                  value={startOffset}
                  onChange={e => setStartOffset(Number(e.target.value))}
                />
              </label>
              <label>
                Increment (sec)
                <input
                  type="number"
                  value={increment}
                  onChange={e => setIncrement(Number(e.target.value))}
                />
              </label>
            </div>
          </div>

          {error && <p className="error-text">{error}</p>}

          {songs.length > 0 && (
            <>
              <p className="hint">{songs.length} songs found. Preview of assigned offsets:</p>
              <div className="preview-table-wrap">
                <table className="preview-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Title</th>
                      <th>Artist</th>
                      <th>File</th>
                      <th>Offset</th>
                    </tr>
                  </thead>
                  <tbody>
                    {songs.map((s, i) => (
                      <tr key={i}>
                        <td className="col-num">{i + 1}</td>
                        <td>{s.title}</td>
                        <td className="muted">{s.artist}</td>
                        <td className="mono">{s.fileName}</td>
                        <td className="mono">{secToHMS(startOffset + i * increment)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            disabled={songs.length === 0}
            onClick={() => onImport(songs, startOffset, increment)}
          >
            Import {songs.length > 0 ? `${songs.length} songs` : ''}
          </button>
        </div>
      </div>
    </div>
  );
}

import { useState } from 'react';
import type { AppConfig, CsvSong, PlaylistEntry } from '../editorTypes.js';
import { DEFAULT_OFFSET_INCREMENT, DEFAULT_OFFSET_START } from '../defaults.js';
import { secToHMS } from '../utils/format.js';
import { CsvImportModal } from './CsvImportModal.js';

interface Props {
  config: AppConfig;
  onChange: (config: AppConfig) => void;
}

function newEntry(offsetSec: number): PlaylistEntry {
  return {
    song_index: '',
    offset_sec: offsetSec,
    offset_frame: 0,
    note: { description: '', show_secs_after_load: 0 },
  };
}

export function PlaylistEditor({ config, onChange }: Props) {
  const [activeTab, setActiveTab] = useState(0);
  const [showCsvModal, setShowCsvModal] = useState(false);

  const playlists = config.playlists;
  const tab = Math.min(activeTab, Math.max(0, playlists.length - 1));
  const playlist = playlists[tab];

  const setPlaylists = (next: AppConfig['playlists']) =>
    onChange({ ...config, playlists: next });

  const setContent = (content: PlaylistEntry[]) => {
    const next = playlists.map((pl, i) => i === tab ? { ...pl, content } : pl);
    setPlaylists(next);
  };

  const addPlaylist = () => {
    const next = [...playlists, { name: `Playlist ${playlists.length + 1}`, content: [] }];
    setPlaylists(next);
    setActiveTab(next.length - 1);
  };

  const deletePlaylist = (idx: number) => {
    const next = playlists.filter((_, i) => i !== idx);
    setPlaylists(next);
    setActiveTab(Math.min(tab, Math.max(0, next.length - 1)));
  };

  const renamePlaylist = (name: string) => {
    setPlaylists(playlists.map((pl, i) => i === tab ? { ...pl, name } : pl));
  };

  const updateEntry = (idx: number, patch: Partial<PlaylistEntry>) => {
    setContent(playlist.content.map((e, i) => i === idx ? { ...e, ...patch } : e));
  };

  const deleteEntry = (idx: number) => {
    const filtered = playlist.content.filter((_, i) => i !== idx);
    if (idx < playlist.content.length - 1) {
      const gap = playlist.content[idx + 1].offset_sec - playlist.content[idx].offset_sec;
      setContent(filtered.map((entry, i) =>
        i >= idx ? { ...entry, offset_sec: entry.offset_sec - gap } : entry
      ));
    } else {
      setContent(filtered);
    }
  };

  const moveEntry = (idx: number, dir: -1 | 1) => {
    const content = [...playlist.content];
    const target = idx + dir;
    if (target < 0 || target >= content.length) return;
    [content[idx], content[target]] = [content[target], content[idx]];
    setContent(content);
  };

  const addSong = () => {
    const last = playlist.content[playlist.content.length - 1];
    const nextOffset = last
      ? last.offset_sec + DEFAULT_OFFSET_INCREMENT
      : DEFAULT_OFFSET_START;
    setContent([...playlist.content, newEntry(nextOffset)]);
  };

  const clearPlaylist = () => {
    if (confirm(`Clear all songs from "${playlist.name}"?`)) setContent([]);
  };

  const handleCsvImport = (songs: CsvSong[], startOffset: number, increment: number) => {
    const entries: PlaylistEntry[] = songs.map((s, i) => ({
      song_index: s.fileName,
      offset_sec: startOffset + i * increment,
      offset_frame: 0,
      note: { description: '', show_secs_after_load: 0 },
    }));
    setContent([...playlist.content, ...entries]);
    setShowCsvModal(false);
  };

  const lastOffsetSec = playlist?.content[playlist.content.length - 1]?.offset_sec ?? null;

  if (playlists.length === 0) {
    return (
      <section className="playlist-editor">
        <div className="section-header">
          <h2>Playlists</h2>
        </div>
        <div className="empty-state">
          <p>No playlists yet.</p>
          <button className="btn btn-primary" onClick={addPlaylist}>Add Playlist</button>
        </div>
      </section>
    );
  }

  return (
    <section className="playlist-editor">
      <div className="section-header">
        <h2>Playlists</h2>
      </div>

      <div className="playlist-tabs">
        {playlists.map((pl, i) => (
          <div
            key={i}
            className={`tab ${i === tab ? 'tab-active' : ''}`}
            onClick={() => setActiveTab(i)}
          >
            <span>{pl.name}</span>
            <button
              className="tab-close"
              title="Delete playlist"
              onClick={e => { e.stopPropagation(); deletePlaylist(i); }}
            >
              ✕
            </button>
          </div>
        ))}
        <button className="tab tab-add" onClick={addPlaylist} title="Add playlist">+</button>
      </div>

      <div className="playlist-toolbar">
        <label className="rename-label">
          Name
          <input
            type="text"
            value={playlist.name}
            onChange={e => renamePlaylist(e.target.value)}
            className="rename-input"
          />
        </label>
        <div className="toolbar-actions">
          <button className="btn btn-secondary" onClick={() => setShowCsvModal(true)}>
            Import CSV
          </button>
          <button className="btn btn-secondary" onClick={addSong}>
            Add Song
          </button>
          <button className="btn btn-danger" onClick={clearPlaylist}>
            Clear
          </button>
        </div>
      </div>

      {playlist.content.length === 0 ? (
        <div className="empty-state small">
          <p>No songs. Import from CSV or add manually.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="song-table">
            <thead>
              <tr>
                <th className="col-num">#</th>
                <th className="col-mashup" title="Mashup / vocals only — overlay track, no timecode, no offset, skipped in next-track display">M</th>
                <th className="col-song">Song Index</th>
                <th className="col-offset">Offset (sec)</th>
                <th className="col-frame">Frame</th>
                <th className="col-note">Note</th>
                <th className="col-showsec">Show N sec after load</th>
                <th className="col-actions"></th>
              </tr>
            </thead>
            <tbody>
              {playlist.content.map((entry, i) => {
                const mashup = entry.mashup_only === true;
                return (
                <tr key={i} className={mashup ? 'row-mashup' : ''}>
                  <td className="col-num muted">{i + 1}</td>
                  <td className="col-mashup">
                    <input
                      type="checkbox"
                      title="Mashup / vocals only — overlay track, no timecode, no offset, skipped in next-track display"
                      checked={mashup}
                      onChange={e =>
                        updateEntry(i, { mashup_only: e.target.checked ? true : undefined })
                      }
                    />
                  </td>
                  <td className="col-song">
                    <input
                      type="text"
                      className="cell-input mono"
                      value={entry.song_index}
                      onChange={e => updateEntry(i, { song_index: e.target.value })}
                    />
                  </td>
                  <td className={`col-offset${mashup ? ' cell-disabled' : ''}`}>
                    <div className="offset-cell">
                      <input
                        type="number"
                        className="cell-input"
                        disabled={mashup}
                        value={entry.offset_sec}
                        onChange={e => updateEntry(i, { offset_sec: Number(e.target.value) })}
                      />
                      <span className="hms-badge">{secToHMS(entry.offset_sec)}</span>
                    </div>
                  </td>
                  <td className={`col-frame${mashup ? ' cell-disabled' : ''}`}>
                    <input
                      type="number"
                      className="cell-input"
                      disabled={mashup}
                      min={0}
                      max={29}
                      value={entry.offset_frame}
                      onChange={e => updateEntry(i, { offset_frame: Number(e.target.value) })}
                    />
                  </td>
                  <td className={`col-note${mashup ? ' cell-disabled' : ''}`}>
                    <input
                      type="text"
                      className="cell-input"
                      disabled={mashup}
                      value={entry.note.description}
                      placeholder="note…"
                      onChange={e =>
                        updateEntry(i, { note: { ...entry.note, description: e.target.value } })
                      }
                    />
                  </td>
                  <td className={`col-showsec${mashup ? ' cell-disabled' : ''}`}>
                    <input
                      type="number"
                      className="cell-input"
                      disabled={mashup}
                      value={entry.note.show_secs_after_load}
                      onChange={e =>
                        updateEntry(i, {
                          note: {
                            ...entry.note,
                            show_secs_after_load: Number(e.target.value),
                          },
                        })
                      }
                    />
                  </td>
                  <td className="col-actions">
                    <button className="btn-icon" title="Move up" onClick={() => moveEntry(i, -1)}>↑</button>
                    <button className="btn-icon" title="Move down" onClick={() => moveEntry(i, 1)}>↓</button>
                    <button className="btn-icon danger" title="Delete" onClick={() => deleteEntry(i)}>✕</button>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showCsvModal && (
        <CsvImportModal
          lastOffsetSec={lastOffsetSec}
          onImport={handleCsvImport}
          onClose={() => setShowCsvModal(false)}
        />
      )}
    </section>
  );
}

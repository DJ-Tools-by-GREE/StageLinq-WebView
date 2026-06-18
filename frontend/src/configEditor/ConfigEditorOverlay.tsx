import { useEffect, useState } from 'react';
import type { AppConfig } from './editorTypes.js';
import { DEFAULT_CONFIG } from './defaults.js';
import { loadConfig, saveConfig } from './restApi.js';
import { GlobalSettings } from './components/GlobalSettings.js';
import { PlaylistEditor } from './components/PlaylistEditor.js';
import './editor.css';

interface Props {
  onClose: () => void;
}

/**
 * Full-screen overlay that hosts the StageLinq config editor against the
 * running backend. Loads `/api/config` on mount, lets the operator edit
 * everything, and PUTs back on Save. The save path is *write-only* — the
 * backend persists to disk but does not hot-reload; the operator presses
 * Ctrl+R in the backend TTY (or restarts the process) to apply.
 *
 * Esc / outer-backdrop click prompts to discard if dirty.
 */
export default function ConfigEditorOverlay({ onClose }: Props) {
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const [sourcePath, setSourcePath] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [legacyNoteBanner, setLegacyNoteBanner] = useState(false);
  const [savedBanner, setSavedBanner] = useState(false);

  // Load on mount.
  useEffect(() => {
    const ac = new AbortController();
    loadConfig(ac.signal)
      .then(({ config: c, sourcePath: p, legacyNoteFieldFound }) => {
        setConfig(c);
        setSourcePath(p);
        setLegacyNoteBanner(legacyNoteFieldFound);
        // Legacy migration mutates the in-memory config; treat as dirty so the
        // operator is prompted to save the upgraded shape.
        setDirty(legacyNoteFieldFound);
        setLoaded(true);
      })
      .catch(e => {
        if ((e as Error).name === 'AbortError') return;
        setLoadError((e as Error).message);
        setLoaded(true);
      });
    return () => ac.abort();
  }, []);

  // Esc to close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') tryClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);

  const tryClose = () => {
    if (dirty && !confirm('Discard unsaved changes and close the editor?')) return;
    onClose();
  };

  const updateConfig = (next: AppConfig) => {
    setConfig(next);
    setDirty(true);
    setSavedBanner(false);
  };

  const handleSave = async () => {
    setSaveError('');
    setSavedBanner(false);
    try {
      await saveConfig(config);
      setDirty(false);
      setLegacyNoteBanner(false);
      setSavedBanner(true);
    } catch (e) {
      setSaveError(`Save failed: ${(e as Error).message}`);
    }
  };

  return (
    <div
      className="config-editor-overlay"
      onMouseDown={e => { if (e.target === e.currentTarget) tryClose(); }}
    >
      <div className="config-editor-root" onMouseDown={e => e.stopPropagation()}>
        <header className="app-header">
          <div className="header-title">
            <span className="logo">◈</span>
            <span className="title">Config Editor</span>
          </div>

          <div className="header-file">
            <span className={`file-indicator${sourcePath ? '' : ' muted'}`}>
              {sourcePath ?? 'loading…'}
              {dirty ? <span className="dirty-dot"> *</span> : null}
            </span>
          </div>

          <div className="header-actions">
            <button
              className="btn btn-primary"
              onClick={handleSave}
              disabled={!loaded || !dirty || !!loadError}
            >
              Save
            </button>
            <button className="btn btn-secondary" onClick={tryClose}>
              Close
            </button>
          </div>
        </header>

        {loadError && (
          <div className="error-banner">Failed to load config: {loadError}</div>
        )}
        {saveError && (
          <div className="error-banner">{saveError}</div>
        )}
        {savedBanner && (
          <div className="info-banner">
            Saved. Press <strong>Ctrl+R</strong> in the backend terminal (or restart the process) to apply changes to the running show.
          </div>
        )}
        {legacyNoteBanner && (
          <div className="warning-banner">
            <span>
              Legacy <code>show_secs_before_transition_starts</code> values discarded — review note timings. The field has been replaced by <code>show_secs_after_load</code> (timer now starts at track-load, not transition-start).
            </span>
            <button
              className="btn btn-icon"
              title="Dismiss"
              onClick={() => setLegacyNoteBanner(false)}
            >
              ✕
            </button>
          </div>
        )}

        <main className="app-main">
          {!loaded ? (
            <div className="empty-state">Loading…</div>
          ) : loadError ? null : (
            <>
              <GlobalSettings config={config} onChange={updateConfig} />
              <PlaylistEditor config={config} onChange={updateConfig} />
            </>
          )}
        </main>
      </div>
    </div>
  );
}

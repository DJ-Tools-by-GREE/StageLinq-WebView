import { useCallback, useEffect, useRef, useState } from 'react';
import { VIDEO_STATUS_POLL_INTERVAL_MS, VIDEO_STATUS_REQUEST_TIMEOUT_MS } from './constants.js';
import { fetchVideoStatus, rescanVideos } from './videoApi.js';
import type { VideoDeckStatus, VideoStatus } from './videoTypes.js';

interface Props {
  onOpenConfigEditor: () => void;
}

const STATE_LABELS: Record<VideoDeckStatus['state'], string> = {
  idle: 'Idle',
  unmatched: 'No video',
  ambiguous: 'Duplicate matches',
  loading: 'Loading',
  playing: 'Playing',
  black: 'Black',
  error: 'Error',
};

export default function VideoStatusPanel({ onOpenConfigEditor }: Props) {
  const [status, setStatus] = useState<VideoStatus | null>(null);
  const [loadError, setLoadError] = useState('');
  const [scanError, setScanError] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scanMessage, setScanMessage] = useState('');
  const mounted = useRef(false);
  const revision = useRef(0);
  const pollRequest = useRef<AbortController | null>(null);
  const scanRequest = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (!mounted.current || pollRequest.current || scanRequest.current) return;
    const controller = new AbortController();
    const currentRevision = ++revision.current;
    pollRequest.current = controller;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, VIDEO_STATUS_REQUEST_TIMEOUT_MS);
    try {
      const next = await fetchVideoStatus(controller.signal);
      if (mounted.current && revision.current === currentRevision) {
        setStatus(next);
        setLoadError('');
      }
    } catch (error) {
      if (mounted.current && revision.current === currentRevision && (!controller.signal.aborted || timedOut)) {
        setLoadError(timedOut ? 'Video status request timed out.' : error instanceof Error ? error.message : String(error));
      }
    } finally {
      clearTimeout(timeout);
      if (pollRequest.current === controller) pollRequest.current = null;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => { void refresh(); }, VIDEO_STATUS_POLL_INTERVAL_MS);
    return () => {
      mounted.current = false;
      revision.current += 1;
      clearInterval(timer);
      pollRequest.current?.abort();
      pollRequest.current = null;
      scanRequest.current?.abort();
      scanRequest.current = null;
    };
  }, [refresh]);

  const rescan = useCallback(async () => {
    if (!mounted.current || scanRequest.current) return;
    const controller = new AbortController();
    const currentRevision = ++revision.current;
    scanRequest.current = controller;
    pollRequest.current?.abort();
    pollRequest.current = null;
    setScanning(true);
    setScanError('');
    setScanMessage('');
    try {
      const next = await rescanVideos(controller.signal);
      if (mounted.current && revision.current === currentRevision) {
        setStatus(next);
        setLoadError('');
        setScanMessage(`Scan complete: ${next.indexedVideos} video files indexed.`);
      }
    } catch (error) {
      if (mounted.current && revision.current === currentRevision && !controller.signal.aborted) {
        setScanError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (scanRequest.current === controller) {
        scanRequest.current = null;
        if (mounted.current) setScanning(false);
      }
    }
  }, []);

  return (
    <section className="settingsSection videoStatusSection">
      <div className="videoStatusHeading">
        <h3 className="settingsSectionTitle">Video / NDI®</h3>
        <span className={`videoState ${status?.running ? 'videoState--playing' : ''}`}>
          {loadError ? 'Status unavailable' : status ? status.enabled ? status.running ? 'Running' : 'Unavailable' : 'Disabled' : 'Loading…'}
        </span>
      </div>
      <div className="videoStatusActions">
        <button className="toggleBtn off" onClick={onOpenConfigEditor}>Configure video…</button>
        <button className="toggleBtn off" disabled={scanning || !status?.directory} onClick={() => { void rescan(); }}>
          {scanning ? 'Scanning…' : 'Rescan videos'}
        </button>
      </div>
      <p className="settingHint">
        Changes in the config editor take effect after Save and Reload config. Rescan uses the active folder
        and reloads its mappings.json file.
      </p>
      {loadError && <p role="alert" className="videoStatusError">Status unavailable: {loadError}</p>}
      {scanError && <p role="alert" className="videoStatusError">Rescan failed: {scanError}</p>}
      {scanMessage && <p role="status" className="settingHint">{scanMessage}</p>}
      {status && (
        <>
          <p className="settingHint videoLibrarySummary">
            <span>{status.directory || 'No video folder configured'}</span>
            <span>{status.indexedVideos} video files · {status.outputFormat === 'source' ? 'Source format' : '1080p30'}</span>
          </p>
          {!status.multiNdiStream && (
            <p className="settingHint">NDI source <strong>{status.sourcePrefix}</strong> · {status.activeDeck ? `Deck ${status.activeDeck}` : 'No playing deck'}</p>
          )}
          {status.error && <p role="alert" className="videoStatusError">{status.error}</p>}
          {status.ambiguousMatches.length > 0 && (
            <details className="videoMatchConflicts">
              <summary>{status.ambiguousMatches.length} filenames have duplicate automatic matches</summary>
              <p className="settingHint">Select a video for each audio filename in mappings.json, or keep one matching video, then rescan. Tracks without an explicit mapping remain black when their automatic match is ambiguous.</p>
              <ul>{status.ambiguousMatches.map(name => <li key={name}>{name}</li>)}</ul>
            </details>
          )}
          <div className="videoDeckStatusGrid">
            {([1, 2, 3, 4] as const).map(deck => {
              const output = status.decks[deck];
              return (
                <article className={`videoDeckStatus videoDeckStatus--${deck}`} key={deck}>
                  <div className="videoStatusHeading">
                    <strong>Deck {deck}</strong>
                    <span className={`videoState videoState--${output.state}`}>{STATE_LABELS[output.state]}</span>
                  </div>
                  {status.multiNdiStream && output.sourceName && <span className="videoSourceName" title={output.sourceName}>{output.sourceName}</span>}
                  <span className="videoTrackName" title={output.track}>{output.track || 'No track loaded'}</span>
                  {output.video && <span className="videoFileName" title={output.video}>{output.video}</span>}
                  {output.width != null && output.height != null && (
                    <span className="settingHint">
                      {output.width} × {output.height}{output.fps != null ? ` · ${output.fps.toFixed(2)} fps` : ''}
                      {output.positionSec != null ? ` · ${output.positionSec.toFixed(2)} s` : ''}
                    </span>
                  )}
                  {output.message && <span className={output.state === 'error' || output.state === 'ambiguous' ? 'videoStatusError' : 'settingHint'}>{output.message}</span>}
                </article>
              );
            })}
          </div>
        </>
      )}
      <p className="settingHint"><a href="https://ndi.video/" target="_blank" rel="noreferrer">NDI®</a> is a registered trademark of Vizrt NDI AB.</p>
    </section>
  );
}

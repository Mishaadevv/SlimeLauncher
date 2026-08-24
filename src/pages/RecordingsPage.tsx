import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Video, Square, FolderOpen, Trash2, Play, Keyboard, MonitorPlay,
  Download, Settings2, Film, Circle, RefreshCw, Camera, Image, Search, HardDrive,
  Mic, Volume2,
} from 'lucide-react';
import { Card } from '@/components/Card';
import { Button } from '@/components/Button';
import { Toggle } from '@/components/Toggle';
import { Input } from '@/components/Input';
import { EmptyState } from '@/components/EmptyState';
import { HotkeyInput } from '@/components/HotkeyInput';
import { useSettingsStore } from '@/store/settings-store';
import { useNotificationStore } from '@/store/notification-store';
import { t } from '@/lib/i18n';
import type {
  RecordingEntry, RecordingSettings, RecordingStatus, FfmpegStatus,
  ScreenshotEntry, RecordingStats,
} from '@shared/types';
import './RecordingsPage.css';

const IDLE_STATUS: RecordingStatus = {
  state: 'idle',
  startedAt: null,
  fileName: null,
  elapsedMs: 0,
  error: null,
  install: null,
};

const EMPTY_STATS: RecordingStats = {
  videoCount: 0,
  screenshotCount: 0,
  videoBytes: 0,
  screenshotBytes: 0,
  totalBytes: 0,
};

type GalleryKind = 'videos' | 'shots';
type SortKey = 'newest' | 'oldest' | 'largest' | 'longest';

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

const toFileUrl = (p: string) => `file:///${p.replace(/\\/g, '/')}`;

function VideoCard({ entry, onPlay, onDelete }: {
  entry: RecordingEntry;
  onPlay: (e: RecordingEntry) => void;
  onDelete: (e: RecordingEntry) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  // Chromium paints the first frame once the video is seeked — gives the
  // gallery real thumbnails without generating separate image files.
  const onLoaded = () => {
    const v = videoRef.current;
    if (v) {
      try { v.currentTime = Math.min(0.05, (v.duration || 0) / 2); } catch { /* ignore */ }
    }
  };

  return (
    <Card className="rec-card" hover interactive onClick={() => onPlay(entry)}>
      <div className="rec-thumb">
        <video
          ref={videoRef}
          src={toFileUrl(entry.filePath)}
          preload="metadata"
          muted
          playsInline
          onLoadedMetadata={onLoaded}
        />
        <span className="rec-thumb-duration">{formatDuration(entry.durationMs)}</span>
        <span className="rec-thumb-play"><Play size={22} /></span>
      </div>
      <div className="rec-card-body">
        <div className="rec-card-name" title={entry.fileName}>{entry.fileName}</div>
        <div className="rec-card-meta">
          <span>{entry.instanceName || t('recordings.gallery.manual')}</span>
          <span>{formatBytes(entry.sizeBytes)}</span>
        </div>
        <div className="rec-card-meta">
          <span>{entry.resolution} · {entry.fps} FPS</span>
          <span>{formatDate(entry.createdAt)}</span>
        </div>
        <div className="rec-card-actions">
          <Button variant="secondary" size="sm" icon={<Play size={13} />} onClick={(e) => { e.stopPropagation(); onPlay(entry); }}>
            {t('recordings.gallery.play')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={<Trash2 size={13} />}
            onClick={(e) => { e.stopPropagation(); onDelete(entry); }}
          >
            {t('recordings.gallery.delete')}
          </Button>
        </div>
      </div>
    </Card>
  );
}

function ShotCard({ entry, onView, onDelete }: {
  entry: ScreenshotEntry;
  onView: (e: ScreenshotEntry) => void;
  onDelete: (e: ScreenshotEntry) => void;
}) {
  return (
    <Card className="rec-card rec-shot-card" hover interactive onClick={() => onView(entry)}>
      <div className="rec-thumb rec-shot-thumb">
        <img src={toFileUrl(entry.filePath)} alt={entry.fileName} loading="lazy" />
        {entry.width > 0 && entry.height > 0 && (
          <span className="rec-thumb-duration">{entry.width}×{entry.height}</span>
        )}
        <span className="rec-thumb-play"><Image size={22} /></span>
      </div>
      <div className="rec-card-body">
        <div className="rec-card-name" title={entry.fileName}>{entry.fileName}</div>
        <div className="rec-card-meta">
          <span>{entry.instanceName || t('recordings.gallery.manual')}</span>
          <span>{formatBytes(entry.sizeBytes)}</span>
        </div>
        <div className="rec-card-meta">{formatDate(entry.createdAt)}</div>
        <div className="rec-card-actions">
          <Button variant="secondary" size="sm" icon={<Image size={13} />} onClick={(e) => { e.stopPropagation(); onView(entry); }}>
            {t('recordings.gallery.view')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={<Trash2 size={13} />}
            onClick={(e) => { e.stopPropagation(); onDelete(entry); }}
          >
            {t('recordings.gallery.delete')}
          </Button>
        </div>
      </div>
    </Card>
  );
}

export function RecordingsPage() {
  const { settings, update } = useSettingsStore();
  const { add } = useNotificationStore();
  const rec: RecordingSettings = settings.recording;
  const [entries, setEntries] = useState<RecordingEntry[]>([]);
  const [shots, setShots] = useState<ScreenshotEntry[]>([]);
  const [stats, setStats] = useState<RecordingStats>(EMPTY_STATS);
  const [status, setStatus] = useState<RecordingStatus>(IDLE_STATUS);
  const [ffmpeg, setFfmpeg] = useState<FfmpegStatus>({ available: false, path: null, downloading: false });
  const [audioDevices, setAudioDevices] = useState<string[]>([]);
  const [installing, setInstalling] = useState(false);
  const [playing, setPlaying] = useState<RecordingEntry | null>(null);
  const [shotView, setShotView] = useState<ScreenshotEntry | null>(null);
  const [shotBusy, setShotBusy] = useState(false);
  const [view, setView] = useState<'record' | 'gallery'>('record');
  const [galleryKind, setGalleryKind] = useState<GalleryKind>('videos');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('newest');
  const [now, setNow] = useState(Date.now());

  const setRec = useCallback((patch: Partial<RecordingSettings>) => {
    void update({ recording: { ...rec, ...patch } } as never);
  }, [rec, update]);

  const loadEntries = useCallback(async () => {
    try {
      setEntries(await window.slime.rec.list());
    } catch { /* ignore */ }
  }, []);

  const loadShots = useCallback(async () => {
    try {
      setShots(await window.slime.rec.shotList());
    } catch { /* ignore */ }
  }, []);

  const loadStats = useCallback(async () => {
    try {
      setStats(await window.slime.rec.stats());
    } catch { /* ignore */ }
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await window.slime.rec.status());
    } catch { /* ignore */ }
  }, []);

  const loadFfmpeg = useCallback(async () => {
    try {
      setFfmpeg(await window.slime.rec.ffmpegStatus());
    } catch { /* ignore */ }
  }, []);

  const loadAudioDevices = useCallback(async () => {
    try {
      setAudioDevices(await window.slime.rec.audioDevices());
    } catch { /* ignore */ }
  }, []);

  const reloadAll = useCallback(() => {
    void loadEntries();
    void loadShots();
    void loadStats();
  }, [loadEntries, loadShots, loadStats]);

  useEffect(() => {
    void loadEntries();
    void loadShots();
    void loadStats();
    void loadStatus();
    void loadFfmpeg();
    void loadAudioDevices();
    const unsub = window.slime.rec.onStatus((s) => {
      setStatus((prev) => {
        if (prev.state !== s.state) {
          if (s.state === 'recording') {
            add({ type: 'success', title: t('recordings.notif.start'), message: s.fileName || '', duration: 2500 });
          } else if (s.state === 'idle' && prev.state === 'recording') {
            if (s.error) {
              add({ type: 'error', title: t('recordings.notif.error_title'), message: s.error, duration: 6000 });
            } else {
              add({ type: 'success', title: t('recordings.notif.stop'), message: s.fileName || '', duration: 4000 });
              void loadEntries();
              void loadStats();
            }
          }
        }
        return s;
      });
    });
    const unsubShot = window.slime.rec.onShot((s) => {
      setShots((prev) => [s, ...prev.filter((x) => x.id !== s.id)]);
      add({ type: 'success', title: t('recordings.notif.shot'), message: s.fileName, duration: 2500 });
      void loadStats();
    });
    return () => { unsub(); unsubShot(); };
  }, [add, loadEntries, loadShots, loadStats, loadStatus, loadFfmpeg]);

  // Tick for the live timer
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const elapsed = useMemo(() => {
    if (status.state !== 'recording' || !status.startedAt) return 0;
    return now - status.startedAt;
  }, [status.state, status.startedAt, now]);

  const toggleRecording = async () => {
    if (status.state === 'recording') {
      await window.slime.rec.stop();
    } else {
      const res = await window.slime.rec.start();
      if (!res.ok && res.error) {
        add({ type: 'error', title: t('recordings.notif.error_title'), message: res.error, duration: 6000 });
      }
    }
  };

  const captureShot = async () => {
    setShotBusy(true);
    try {
      const res = await window.slime.rec.shotCapture();
      if (!res.ok && res.error) {
        add({ type: 'error', title: t('recordings.notif.error_title'), message: res.error, duration: 6000 });
      }
      // Success is announced by the rec:shotEvent broadcast (also covers the
      // global-hotkey path), so no duplicate notification here.
    } finally {
      setShotBusy(false);
    }
  };

  const installFfmpeg = async () => {
    setInstalling(true);
    try {
      const res = await window.slime.rec.installFfmpeg();
      if (res.ok) {
        add({ type: 'success', title: t('recordings.notif.ffmpeg_ok'), message: '', duration: 3500 });
      } else {
        add({ type: 'error', title: t('recordings.notif.error_title'), message: res.error || '', duration: 6000 });
      }
      void loadFfmpeg();
    } finally {
      setInstalling(false);
    }
  };

  const pickFolder = async () => {
    const dir = await window.slime.fs.selectDirectory();
    if (dir) setRec({ folder: dir });
  };

  const deleteEntry = async (entry: RecordingEntry) => {
    if (!confirm(t('recordings.gallery.delete_confirm'))) return;
    await window.slime.rec.delete(entry.id);
    void loadEntries();
    void loadStats();
  };

  const deleteShot = async (entry: ScreenshotEntry) => {
    if (!confirm(t('recordings.gallery.delete_shot_confirm'))) return;
    await window.slime.rec.shotDelete(entry.id);
    setShots((prev) => prev.filter((s) => s.id !== entry.id));
    if (shotView?.id === entry.id) setShotView(null);
    void loadStats();
  };

  const filteredVideos = useMemo(() => {
    let list = entries;
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (e) => e.fileName.toLowerCase().includes(q) || (e.instanceName || '').toLowerCase().includes(q)
      );
    }
    const arr = [...list];
    switch (sort) {
      case 'oldest': arr.sort((a, b) => a.createdAt - b.createdAt); break;
      case 'largest': arr.sort((a, b) => b.sizeBytes - a.sizeBytes); break;
      case 'longest': arr.sort((a, b) => b.durationMs - a.durationMs); break;
      default: arr.sort((a, b) => b.createdAt - a.createdAt);
    }
    return arr;
  }, [entries, search, sort]);

  const filteredShots = useMemo(() => {
    let list = shots;
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (s) => s.fileName.toLowerCase().includes(q) || (s.instanceName || '').toLowerCase().includes(q)
      );
    }
    const arr = [...list];
    switch (sort) {
      case 'oldest': arr.sort((a, b) => a.createdAt - b.createdAt); break;
      case 'longest':
      case 'largest': arr.sort((a, b) => b.sizeBytes - a.sizeBytes); break;
      default: arr.sort((a, b) => b.createdAt - a.createdAt);
    }
    return arr;
  }, [shots, search, sort]);

  const recording = status.state === 'recording';
  const stopping = status.state === 'stopping';

  return (
    <div className="recordings-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('recordings.title')}</h1>
          <p className="page-subtitle">{t('recordings.subtitle')}</p>
        </div>
        <Button variant="ghost" size="sm" icon={<FolderOpen size={14} />} onClick={() => window.slime.rec.openFolder()}>
          {t('recordings.gallery.open_folder')}
        </Button>
      </div>

      {/* Sub-tabs */}
      <div className="rec-tabs">
        <button className={`rec-tab ${view === 'record' ? 'rec-tab-active' : ''}`} onClick={() => setView('record')}>
          <Settings2 size={14} /> {t('recordings.tab.record')}
        </button>
        <button className={`rec-tab ${view === 'gallery' ? 'rec-tab-active' : ''}`} onClick={() => setView('gallery')}>
          <Film size={14} /> {t('recordings.tab.gallery')}
          <span className="rec-tab-count">{entries.length + shots.length}</span>
        </button>
      </div>

      {/* Status / control */}
      <Card className={`rec-status-card ${recording ? 'rec-status-recording' : ''}`}>
        <div className="rec-status-left">
          <div className={`rec-status-icon ${recording ? 'rec-status-icon-live' : ''}`}>
            {recording ? <Circle size={20} /> : <Video size={20} />}
          </div>
          <div>
            <div className="rec-status-title">
              {stopping
                ? t('recordings.status_stopping')
                : recording
                  ? t('recordings.status_recording')
                  : t('recordings.status_idle')}
            </div>
            <div className="rec-status-sub">
              {recording && status.fileName
                ? (
                  <>
                    <span className="rec-timer">{formatDuration(elapsed)}</span>
                    <span className="rec-status-file" title={status.fileName}>{status.fileName}</span>
                  </>
                )
                : rec.enabled
                  ? (
                    <>
                      <span>{t('recordings.hotkey_hint', { hotkey: rec.hotkey })}</span>
                      {rec.screenshotHotkey && (
                        <span>{t('recordings.shot_hotkey_hint', { hotkey: rec.screenshotHotkey })}</span>
                      )}
                    </>
                  )
                  : t('recordings.hotkey_hint_disabled')}
            </div>
            {status.error && <div className="rec-status-error">{t('recordings.error', { error: status.error })}</div>}
          </div>
        </div>
        <div className="rec-status-right rec-status-actions">
          <Button
            variant="secondary"
            size="lg"
            icon={<Camera size={16} />}
            loading={shotBusy}
            disabled={!rec.enabled || !ffmpeg.available}
            onClick={() => void captureShot()}
          >
            {t('recordings.shot')}
          </Button>
          <Button
            variant={recording ? 'danger' : 'primary'}
            size="lg"
            icon={recording ? <Square size={16} /> : <Video size={16} />}
            loading={stopping || installing}
            disabled={!rec.enabled && !recording}
            onClick={() => void toggleRecording()}
          >
            {recording ? t('recordings.stop') : t('recordings.start')}
          </Button>
        </div>
      </Card>

      {view === 'record' && (
        <>
          {/* ffmpeg warning */}
          {!ffmpeg.available && (
            <Card className="rec-ffmpeg-card">
              <div className="rec-ffmpeg-icon"><Download size={18} /></div>
              <div className="rec-ffmpeg-body">
                <div className="rec-ffmpeg-title">{t('recordings.ffmpeg_missing')}</div>
                <div className="rec-ffmpeg-desc">{t('recordings.ffmpeg_missing_desc')}</div>
              </div>
              <Button
                variant="secondary"
                icon={<Download size={14} />}
                loading={installing}
                onClick={() => void installFfmpeg()}
              >
                {t('recordings.install_ffmpeg')}
              </Button>
            </Card>
          )}
          {ffmpeg.available && !ffmpeg.downloading && (
            <div className="rec-ffmpeg-ok">{t('recordings.ffmpeg_installed')}</div>
          )}
          {status.install && (
            <Card className="rec-ffmpeg-card">
              <div className="rec-ffmpeg-icon"><Download size={18} /></div>
              <div className="rec-ffmpeg-body" style={{ flex: 1 }}>
                <div className="rec-ffmpeg-title">{status.install.label}</div>
                <div className="rec-ffmpeg-progress">
                  <div className="rec-ffmpeg-progress-bar" style={{ width: `${status.install.progress}%` }} />
                </div>
              </div>
            </Card>
          )}

          {/* Settings */}
          <Card className="rec-settings-card">
            <div className="rec-settings-head">
              <h3><Settings2 size={15} /> {t('recordings.settings.title')}</h3>
            </div>
            <div className="rec-settings-grid">
              <div className="rec-setting">
                <div>
                  <div className="rec-setting-label">{t('recordings.settings.enabled')}</div>
                  <div className="rec-setting-desc">{t('recordings.settings.enabled_desc')}</div>
                </div>
                <Toggle checked={rec.enabled} onChange={(v) => setRec({ enabled: v })} />
              </div>
              <div className="rec-setting">
                <div>
                  <div className="rec-setting-label">{t('recordings.settings.auto')}</div>
                  <div className="rec-setting-desc">{t('recordings.settings.auto_desc')}</div>
                </div>
                <Toggle checked={rec.autoStart} onChange={(v) => setRec({ autoStart: v })} />
              </div>
              <div className="rec-setting">
                <div>
                  <div className="rec-setting-label">{t('recordings.settings.fps')}</div>
                  <div className="rec-setting-desc">{t('recordings.settings.fps_desc')}</div>
                </div>
                <select className="select" value={rec.fps} onChange={(e) => setRec({ fps: Number(e.target.value) })}>
                  {[30, 60, 120].map((f) => <option key={f} value={f}>{f} FPS</option>)}
                </select>
              </div>
              <div className="rec-setting">
                <div>
                  <div className="rec-setting-label">{t('recordings.settings.quality')}</div>
                  <div className="rec-setting-desc">{t('recordings.settings.quality_desc')}</div>
                </div>
                <select className="select" value={rec.quality} onChange={(e) => setRec({ quality: e.target.value as RecordingSettings['quality'] })}>
                  <option value="low">{t('recordings.quality.low')}</option>
                  <option value="medium">{t('recordings.quality.medium')}</option>
                  <option value="high">{t('recordings.quality.high')}</option>
                  <option value="ultra">{t('recordings.quality.ultra')}</option>
                </select>
              </div>
              <div className="rec-setting">
                <div>
                  <div className="rec-setting-label">{t('recordings.settings.resolution')}</div>
                  <div className="rec-setting-desc">{t('recordings.settings.resolution_desc')}</div>
                </div>
                <select className="select" value={rec.resolution} onChange={(e) => setRec({ resolution: e.target.value as RecordingSettings['resolution'] })}>
                  <option value="window">{t('recordings.res.window')}</option>
                  <option value="720p">720p</option>
                  <option value="1080p">1080p</option>
                  <option value="1440p">1440p</option>
                  <option value="2160p">2160p</option>
                </select>
              </div>
              <div className="rec-setting">
                <div>
                  <div className="rec-setting-label">{t('recordings.settings.audio')}</div>
                  <div className="rec-setting-desc">{t('recordings.settings.audio_desc')}</div>
                </div>
                <select className="select" value={rec.audio} onChange={(e) => setRec({ audio: e.target.value as RecordingSettings['audio'] })}>
                  <option value="none">{t('recordings.audio.none')}</option>
                  <option value="system">{t('recordings.audio.system')}</option>
                  <option value="mic">{t('recordings.audio.mic')}</option>
                  <option value="both">{t('recordings.audio.both')}</option>
                </select>
              </div>
              {(rec.audio === 'system' || rec.audio === 'both') && (
                <div className="rec-setting">
                  <div>
                    <div className="rec-setting-label"><Volume2 size={13} /> {t('recordings.settings.system_device')}</div>
                    <div className="rec-setting-desc">{t('recordings.settings.system_device_desc')}</div>
                  </div>
                  <div className="setting-input-group">
                    <select
                      className="select"
                      value={rec.systemDevice}
                      onChange={(e) => setRec({ systemDevice: e.target.value })}
                    >
                      <option value="">{t('recordings.audio.auto')}</option>
                      {audioDevices.map((d) => <option key={d} value={d}>{d}</option>)}
                    </select>
                    <Button variant="secondary" size="sm" icon={<RefreshCw size={13} />} onClick={() => void loadAudioDevices()} aria-label="Refresh devices" />
                  </div>
                </div>
              )}
              {(rec.audio === 'mic' || rec.audio === 'both') && (
                <div className="rec-setting">
                  <div>
                    <div className="rec-setting-label"><Mic size={13} /> {t('recordings.settings.mic_device')}</div>
                    <div className="rec-setting-desc">{t('recordings.settings.mic_device_desc')}</div>
                  </div>
                  <div className="setting-input-group">
                    <select
                      className="select"
                      value={rec.micDevice}
                      onChange={(e) => setRec({ micDevice: e.target.value })}
                    >
                      <option value="">{t('recordings.audio.auto')}</option>
                      {audioDevices.map((d) => <option key={d} value={d}>{d}</option>)}
                    </select>
                    <Button variant="secondary" size="sm" icon={<RefreshCw size={13} />} onClick={() => void loadAudioDevices()} aria-label="Refresh devices" />
                  </div>
                </div>
              )}
              <div className="rec-setting">
                <div>
                  <div className="rec-setting-label"><Keyboard size={13} /> {t('recordings.settings.hotkey')}</div>
                  <div className="rec-setting-desc">{t('recordings.settings.hotkey_desc')}</div>
                </div>
                <HotkeyInput value={rec.hotkey} placeholder="F8" onChange={(v) => setRec({ hotkey: v })} />
              </div>
              <div className="rec-setting">
                <div>
                  <div className="rec-setting-label"><Camera size={13} /> {t('recordings.settings.shot_hotkey')}</div>
                  <div className="rec-setting-desc">{t('recordings.settings.shot_hotkey_desc')}</div>
                </div>
                <HotkeyInput value={rec.screenshotHotkey} placeholder="F9" onChange={(v) => setRec({ screenshotHotkey: v })} />
              </div>
              <div className="rec-setting rec-setting-folder">
                <div>
                  <div className="rec-setting-label"><MonitorPlay size={13} /> {t('recordings.settings.folder')}</div>
                  <div className="rec-setting-desc">{t('recordings.settings.folder_desc')}</div>
                </div>
                <div className="setting-input-group">
                  <Input value={rec.folder} readOnly />
                  <Button variant="secondary" size="sm" icon={<FolderOpen size={14} />} onClick={() => void pickFolder()}>
                    {t('settings.browse')}
                  </Button>
                </div>
              </div>
            </div>
          </Card>
        </>
      )}

      {view === 'gallery' && (
        <>
          {/* Gallery toolbar */}
          <div className="rec-gallery-head">
            <div className="rec-gallery-kinds">
              <button
                className={`rec-kind ${galleryKind === 'videos' ? 'rec-kind-active' : ''}`}
                onClick={() => setGalleryKind('videos')}
              >
                <Video size={13} /> {t('recordings.gallery.videos')}
                <span className="rec-tab-count">{entries.length}</span>
              </button>
              <button
                className={`rec-kind ${galleryKind === 'shots' ? 'rec-kind-active' : ''}`}
                onClick={() => setGalleryKind('shots')}
              >
                <Image size={13} /> {t('recordings.gallery.shots')}
                <span className="rec-tab-count">{shots.length}</span>
              </button>
            </div>
            <div className="rec-gallery-tools">
              <div className="rec-gallery-search">
                <Search size={13} />
                <input
                  className="rec-gallery-search-input"
                  value={search}
                  placeholder={galleryKind === 'videos' ? t('recordings.gallery.search_videos') : t('recordings.gallery.search_shots')}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <select className="select rec-gallery-sort" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
                <option value="newest">{t('recordings.gallery.sort_newest')}</option>
                <option value="oldest">{t('recordings.gallery.sort_oldest')}</option>
                <option value="largest">{t('recordings.gallery.sort_largest')}</option>
                {galleryKind === 'videos' && <option value="longest">{t('recordings.gallery.sort_longest')}</option>}
              </select>
              <Button
                variant="ghost"
                size="sm"
                icon={<RefreshCw size={13} />}
                aria-label="Refresh"
                onClick={reloadAll}
              />
            </div>
          </div>

          {/* Storage stats */}
          <div className="rec-stats">
            <span>
              <Video size={13} />
              {stats.videoCount} {plural(stats.videoCount, t('recordings.gallery.video'), t('recordings.gallery.videos')).toLowerCase()}
            </span>
            <span>
              <Image size={13} />
              {stats.screenshotCount} {plural(stats.screenshotCount, t('recordings.gallery.shot'), t('recordings.gallery.shots')).toLowerCase()}
            </span>
            <span className="rec-stats-size"><HardDrive size={13} /> {formatBytes(stats.totalBytes)}</span>
          </div>

          {/* Grid */}
          {galleryKind === 'videos' ? (
            filteredVideos.length === 0 ? (
              <EmptyState
                title={t('recordings.gallery.empty')}
                description={t('recordings.gallery.empty_desc')}
                icon={<Video size={28} />}
              />
            ) : (
              <div className="rec-gallery-grid">
                {filteredVideos.map((entry) => (
                  <VideoCard key={entry.id} entry={entry} onPlay={setPlaying} onDelete={(e) => void deleteEntry(e)} />
                ))}
              </div>
            )
          ) : filteredShots.length === 0 ? (
            <EmptyState
              title={t('recordings.gallery.empty_shots')}
              description={t('recordings.gallery.empty_shots_desc')}
              icon={<Image size={28} />}
            />
          ) : (
            <div className="rec-gallery-grid">
              {filteredShots.map((entry) => (
                <ShotCard key={entry.id} entry={entry} onView={setShotView} onDelete={(e) => void deleteShot(e)} />
              ))}
            </div>
          )}
        </>
      )}

      {/* Player modal */}
      {playing && (
        <div className="rec-player-overlay" onClick={() => setPlaying(null)}>
          <div className="rec-player" onClick={(e) => e.stopPropagation()}>
            <div className="rec-player-head">
              <span className="rec-player-name" title={playing.fileName}>{playing.fileName}</span>
              <button className="rec-player-close" onClick={() => setPlaying(null)} aria-label="Close">✕</button>
            </div>
            <video
              className="rec-player-video"
              src={toFileUrl(playing.filePath)}
              controls
              autoPlay
            />
            <div className="rec-player-meta">
              <span>{playing.resolution} · {playing.fps} FPS · {t('recordings.settings.quality')}: {playing.quality}</span>
              <span>{formatDuration(playing.durationMs)} · {formatBytes(playing.sizeBytes)}</span>
            </div>
          </div>
        </div>
      )}

      {/* Screenshot lightbox */}
      {shotView && (
        <div className="rec-player-overlay" onClick={() => setShotView(null)}>
          <div className="rec-player rec-lightbox" onClick={(e) => e.stopPropagation()}>
            <div className="rec-player-head">
              <span className="rec-player-name" title={shotView.fileName}>{shotView.fileName}</span>
              <button className="rec-player-close" onClick={() => setShotView(null)} aria-label="Close">✕</button>
            </div>
            <img className="rec-lightbox-img" src={toFileUrl(shotView.filePath)} alt={shotView.fileName} />
            <div className="rec-player-meta">
              <span>
                {shotView.width > 0 && shotView.height > 0 ? `${shotView.width}×${shotView.height}` : ''}
                {shotView.instanceName ? ` · ${shotView.instanceName}` : ''}
              </span>
              <span>{formatDate(shotView.createdAt)} · {formatBytes(shotView.sizeBytes)}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

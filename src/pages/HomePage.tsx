import { motion } from 'framer-motion';
import { Play, Settings as SettingsIcon, User, Boxes, Puzzle, Map as MapIcon, Cpu, MemoryStick, FolderOpen, Wrench, Gamepad2, AlertTriangle, X } from 'lucide-react';
import { useInstanceStore } from '@/store/instance-store';
import { useAuthStore } from '@/store/auth-store';
import { useNavigationStore } from '@/store/navigation-store';
import { useNotificationStore } from '@/store/notification-store';
import { AppIcon } from '@/components/AppIcon';
import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { LoadingState } from '@/components/LoadingState';
import { MsAccountAvatar } from '@/components/MsAccountAvatar';
import { t } from '@/lib/i18n';
import { useEffect, useState } from 'react';
import './HomePage.css';

const LOADER_LABEL: Record<string, string> = {
  vanilla: 'Vanilla',
  fabric: 'Fabric',
  forge: 'Forge',
  neoforge: 'NeoForge',
  quilt: 'Quilt',
};

// Formats a number of seconds into a compact human string, e.g. "45 s",
// "2 min 15 s", "1 h 5 min".
function formatEta(seconds: number): string {
  const s = Math.max(1, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return rest > 0 ? `${m} min ${rest} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return rest > 0 ? `${h} h ${m % 60} min` : `${h} h`;
}

export function HomePage() {
  const { instances, selectedId, loading, select } = useInstanceStore();
  const { user, activeMicrosoft } = useAuthStore();
  const { navigate } = useNavigationStore();
  const { add } = useNotificationStore();
  const [launching, setLaunching] = useState(false);
  const [launchStage, setLaunchStage] = useState('');
  const [launchProgress, setLaunchProgress] = useState(0);
  const [launchEta, setLaunchEta] = useState<string | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [modCount, setModCount] = useState(0);
  const [mapCount, setMapCount] = useState(0);

  const selected = instances.find((i) => i.id === selectedId) || null;

  useEffect(() => {
    if (!selected) { setModCount(0); setMapCount(0); return; }
    let cancelled = false;
    window.slime.mod.list(selected.id)
      .then((mods) => { if (!cancelled) setModCount(mods.length); })
      .catch(() => { if (!cancelled) setModCount(0); });
    window.slime.map.list(selected.id)
      .then((maps) => { if (!cancelled) setMapCount(maps.length); })
      .catch(() => { if (!cancelled) setMapCount(0); });
    return () => { cancelled = true; };
  }, [selectedId, selected]);

  const handleLaunch = async () => {
    if (!selected) return;
    setLaunching(true);
    setLaunchStage('Preparing instance...');
    setLaunchProgress(0.05);
    setLaunchEta(null);
    setLaunchError(null);
    // Progress samples used to estimate how much longer the launch will take.
    const samples: { p: number; t: number }[] = [];
    const unsub = window.slime.mc.onLaunchProgress((p) => {
      setLaunchStage(p.message);
      setLaunchProgress(p.progress);
      samples.push({ p: p.progress, t: Date.now() });
      if (samples.length > 30) samples.shift();
      // Estimate ETA from the progress rate over the last ~8 samples. Only
      // meaningful while something is actively progressing.
      if (p.progress > 0.03 && p.progress < 0.98) {
        const recent = samples.slice(-8);
        if (recent.length >= 2) {
          const dt = (recent[recent.length - 1].t - recent[0].t) / 1000;
          const dp = recent[recent.length - 1].p - recent[0].p;
          if (dt > 0.8 && dp > 0.001) {
            const rate = dp / dt;
            const eta = (1 - p.progress) / rate;
            if (eta > 2 && eta < 3600 * 4) {
              setLaunchEta(`≈ ${formatEta(eta)} left`);
              return;
            }
          }
        }
      }
      setLaunchEta(null);
    });
    try {
      const res = await window.slime.mc.launch(selected.id);
      if (!res.ok) {
        setLaunchError(res.error || t('home.launch_error_unknown'));
        add({ type: 'error', title: t('home.launch_failed'), message: res.error || t('home.launch_error_unknown'), duration: 8000 });
      }
    } catch (e) {
      setLaunchError(String(e));
      add({ type: 'error', title: t('home.launch_failed'), message: String(e), duration: 8000 });
    } finally {
      unsub();
      // Keep the error visible after the spinner stops so the player can read
      // what went wrong instead of a toast that vanishes in seconds.
      setTimeout(() => { setLaunching(false); setLaunchStage(''); setLaunchProgress(0); setLaunchEta(null); }, 1500);
    }
  };

  return (
    <div className="home">
      {/* Top bar */}
      <div className="home-top">
        <div className="home-greeting">
          <h1 className="home-title">
            {activeMicrosoft?.username || user?.username
              ? t('home.welcome_back', { name: activeMicrosoft?.username || user?.username || '' })
              : t('home.welcome_default')}
          </h1>
          <p className="home-subtitle">{t('home.journey')}</p>
          {activeMicrosoft && (
            <span className="home-ms-badge">
              <Gamepad2 size={12} /> {t('home.ms_badge', { name: activeMicrosoft.username })}
            </span>
          )}
        </div>
        <div className="home-actions">
          <button className="icon-btn" onClick={() => navigate('settings')} aria-label="Settings">
            <SettingsIcon size={18} />
          </button>
          <button className="icon-btn" onClick={() => navigate(user || activeMicrosoft ? 'account' : 'login')} aria-label="Account">
            {activeMicrosoft ? (
              <MsAccountAvatar active size={22} />
            ) : user?.avatar ? (
              <img src={user.avatar} alt="" className="icon-avatar" />
            ) : (
              <User size={18} />
            )}
          </button>
        </div>
      </div>

      {/* Main content */}
      {loading ? (
        <LoadingState label={t('home.loading_instances')} />
      ) : !selected ? (
        <EmptyState
          title={t('home.no_instances_title')}
          description={t('home.no_instances_desc')}
          action={
            <Button variant="primary" size="lg" icon={<Boxes size={18} />} onClick={() => navigate('instances')}>
              {t('home.create_instance_btn')}
            </Button>
          }
        />
      ) : (
        <div className="home-main">
          {/* Instance selector */}
          {instances.length > 1 && (
            <div className="instance-strip">
              {instances.map((inst) => (
                <button
                  key={inst.id}
                  className={`instance-chip ${inst.id === selected.id ? 'instance-chip-active' : ''}`}
                  onClick={() => select(inst.id)}
                >
                  {inst.icon ? <img src={inst.icon} alt="" className="chip-icon" /> : <AppIcon size={20} />}
                  <span>{inst.name}</span>
                </button>
              ))}
            </div>
          )}

          {/* Big profile card */}
          <motion.div
            className="profile-card"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="profile-card-glow" />
            <div className="profile-card-content">
              <div className="profile-icon">
                {selected.icon ? <img src={selected.icon} alt="" /> : <AppIcon size={64} />}
              </div>
              <div className="profile-info">
                <h2 className="profile-name">{selected.name}</h2>
                <div className="profile-meta">
                  <span className="meta-badge">
                    <Cpu size={13} /> Minecraft {selected.mcVersion}
                  </span>
                  <span className="meta-badge">
                    <Wrench size={13} /> {LOADER_LABEL[selected.loader] || selected.loader}
                  </span>
                  <span className="meta-badge">
                    <MemoryStick size={13} /> {selected.ramMB / 1024 >= 1 ? `${(selected.ramMB / 1024).toFixed(0)} GB` : `${selected.ramMB} MB`} RAM
                  </span>
                </div>
                <div className="profile-stats">
                  <span>{selected.playCount} {t('home.plays_label')}</span>
                  {selected.lastPlayedAt && (
                    <span>{t('home.last_played_label', { date: new Date(selected.lastPlayedAt).toLocaleDateString() })}</span>
                  )}
                </div>
              </div>
            </div>

            <div className="profile-actions">
              <Button
                variant="primary"
                size="lg"
                className="play-btn"
                loading={launching}
                onClick={handleLaunch}
                icon={<Play size={20} fill="currentColor" />}
              >
                {launching ? launchStage || t('home.launching_btn') : t('home.play_btn')}
              </Button>
              {launching && (
                <div className="launch-progress">
                  <div className="launch-progress-bar">
                    <div className="launch-progress-fill" style={{ width: `${Math.max(launchProgress * 100, 2)}%` }} />
                  </div>
                  <span className="launch-progress-text">
                    {launchStage}
                    {launchEta && <span className="launch-eta"> · {launchEta}</span>}
                  </span>
                </div>
              )}
              {launchError && (
                <div className="launch-error" role="alert">
                  <AlertTriangle size={14} className="launch-error-icon" />
                  <span className="launch-error-text">{launchError}</span>
                  <button className="launch-error-close" onClick={() => setLaunchError(null)} aria-label="Dismiss">
                    <X size={13} />
                  </button>
                </div>
              )}
              <div className="profile-quick-actions">
                <Button variant="secondary" size="md" icon={<Puzzle size={16} />} onClick={() => navigate('mods')}>
                  {t('home.mods_btn')}
                </Button>
                <Button variant="secondary" size="md" icon={<MapIcon size={16} />} onClick={() => navigate('maps')}>
                  {t('home.maps_btn')}
                </Button>
                <Button variant="ghost" size="md" icon={<FolderOpen size={16} />} onClick={() => window.slime.instance.openFolder(selected.id)}>
                  {t('home.open_folder_btn')}
                </Button>
              </div>
            </div>
          </motion.div>

          {/* Quick stats */}
          <div className="home-stats">
            <div className="stat-card">
              <Puzzle size={18} className="stat-icon" />
              <div>
                <div className="stat-value">{modCount}</div>
                <div className="stat-label">{t('home.mods_label')}</div>
              </div>
            </div>
            <div className="stat-card">
              <MapIcon size={18} className="stat-icon" />
              <div>
                <div className="stat-value">{mapCount}</div>
                <div className="stat-label">{t('home.maps_label')}</div>
              </div>
            </div>
            <div className="stat-card">
              <Boxes size={18} className="stat-icon" />
              <div>
                <div className="stat-value">{instances.length}</div>
                <div className="stat-label">{t('home.instances_label')}</div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

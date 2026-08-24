import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Download, Layers, Search, Check, Trash2, X, Wrench } from 'lucide-react';
import { Button } from '@/components/Button';
import { LoadingState } from '@/components/LoadingState';
import { EmptyState } from '@/components/EmptyState';
import { useNotificationStore } from '@/store/notification-store';
import { useInstanceStore } from '@/store/instance-store';
import { t } from '@/lib/i18n';
import type { LoaderType, MinecraftInstance } from '@shared/types';
import './CatalogPages.css';

type Version = { id: string; type?: string };

type VersionFilter = 'all' | 'release' | 'snapshot' | 'beta' | 'alpha';

const FILTERS: { id: VersionFilter; label: string }[] = [
  { id: 'all', label: t('versions.all') },
  { id: 'release', label: t('versions.releases') },
  { id: 'snapshot', label: t('versions.snapshots') },
  { id: 'beta', label: t('versions.beta') },
  { id: 'alpha', label: t('versions.alpha') },
];

const LOADERS: { id: LoaderType; label: string }[] = [
  { id: 'vanilla', label: t('versions.vanilla') },
  { id: 'fabric', label: t('versions.fabric') },
  { id: 'forge', label: t('versions.forge') },
  { id: 'neoforge', label: t('versions.neoforge') },
  { id: 'quilt', label: t('versions.quilt') },
];

// Mojang's manifest types use old_beta / old_alpha for pre-1.0 builds and
// snapshot for weekly, pre-release and release-candidate builds. Normalize them
// to the filter ids used by this page.
function normalizeType(type?: string): VersionFilter {
  switch (type) {
    case 'release': return 'release';
    case 'snapshot': return 'snapshot';
    case 'old_beta': return 'beta';
    case 'old_alpha': return 'alpha';
    default: return 'all';
  }
}

function typeLabel(type?: string): string {
  switch (type) {
    case 'release': return t('versions.release_label');
    case 'snapshot': return t('versions.snapshot_label');
    case 'old_beta': return t('versions.beta_label');
    case 'old_alpha': return t('versions.alpha_label');
    default: return t('versions.release_label');
  }
}

function formatEta(seconds: number): string {
  const s = Math.max(1, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return rest > 0 ? `${m} min ${rest} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return rest > 0 ? `${h} h ${m % 60} min` : `${h} h`;
}

const PAGE_SIZE = 40;

interface InstallModal {
  version: Version;
  loader: LoaderType;
  available: Record<string, boolean>;
  installedLoaders: Set<LoaderType>;
  checking: boolean;
  stage: string;
  progress: number;
  eta: string | null;
  error: string | null;
  running: boolean;
}

export function VersionsPage() {
  const { add } = useNotificationStore();
  const { create, instances, remove } = useInstanceStore();
  const [versions, setVersions] = useState<Version[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<VersionFilter>('all');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [install, setInstall] = useState<InstallModal | null>(null);

  useEffect(() => {
    window.slime.mc
      .versions()
      .then((result) => setVersions((result?.versions || []) as Version[]))
      .catch((e) => add({ type: 'error', title: t('versions.versions_unavailable'), message: String(e), duration: 4000 }))
      .finally(() => setLoading(false));
  }, [add]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return versions.filter((v) => {
      if (filter !== 'all' && normalizeType(v.type) !== filter) return false;
      if (q && !v.id.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [versions, query, filter]);

  const visible = filtered.slice(0, visibleCount);

  const openInstall = async (version: Version) => {
    const alreadyInstalled = new Set<LoaderType>(
      instances.filter((i) => i.mcVersion === version.id).map((i) => i.loader)
    );
    // Default to the first loader not yet installed for this version so
    // re-opening the dialog suggests adding a new loader.
    const firstFree = LOADERS.find((l) => !alreadyInstalled.has(l.id))?.id || 'vanilla';
    setInstall({
      version,
      loader: firstFree,
      available: {},
      installedLoaders: alreadyInstalled,
      checking: true,
      stage: t('versions.checking_loaders'),
      progress: 0,
      eta: null,
      error: null,
      running: false,
    });
    // Probe which loaders actually have builds for this version.
    const availability: Record<string, boolean> = { vanilla: true };
    const results = await Promise.all(
      LOADERS.filter((l) => l.id !== 'vanilla').map(async (l) => {
        try {
          const list = await window.slime.mc.loaderVersions(version.id, l.id);
          availability[l.id] = Array.isArray(list) && list.length > 0;
        } catch {
          availability[l.id] = false;
        }
      })
    );
    await results;
    setInstall((prev) => (prev ? { ...prev, available: availability, checking: false } : prev));
  };

  const startInstall = async () => {
    if (!install) return;
    const version = install.version.id;
    const loader = install.loader;
    setInstall((prev) => (prev ? { ...prev, running: true, error: null, progress: 0.02, stage: t('versions.creating_instance') } : prev));
    const samples: { p: number; t: number }[] = [];
    const unsub = window.slime.mc.onLaunchProgress((p) => {
      samples.push({ p: p.progress, t: Date.now() });
      if (samples.length > 30) samples.shift();
      let eta: string | null = null;
      if (p.progress > 0.03 && p.progress < 0.98) {
        const recent = samples.slice(-8);
        if (recent.length >= 2) {
          const dt = (recent[recent.length - 1].t - recent[0].t) / 1000;
          const dp = recent[recent.length - 1].p - recent[0].p;
          if (dt > 0.8 && dp > 0.001) {
            const e = (1 - p.progress) / (dp / dt);
            if (e > 2 && e < 3600 * 4) eta = `≈ ${formatEta(e)} left`;
          }
        }
      }
      setInstall((prev) => (prev ? { ...prev, stage: p.message, progress: p.progress, eta } : prev));
    });
    try {
      const inst = await create({
        name: `Minecraft ${version}${loader !== 'vanilla' ? ` (${loader})` : ''}`,
        mcVersion: version,
        loader,
      });
      if (!inst) {
        setInstall((prev) => (prev ? { ...prev, running: false, error: t('versions.failed_create') } : prev));
        return;
      }
      const result = await window.slime.mc.install({ instanceId: inst.id });
      if (result.ok !== false) {
        add({ type: 'success', title: t('versions.version_prepared'), message: t('versions.version_ready', { version }), duration: 3500 });
        setInstall(null);
      } else {
        setInstall((prev) => (prev ? { ...prev, running: false, error: result.error || t('versions.installation_failed') } : prev));
      }
    } catch (e) {
      setInstall((prev) => (prev ? { ...prev, running: false, error: String(e) } : prev));
    } finally {
      unsub();
    }
  };

  const deleteVersion = async (inst: MinecraftInstance) => {
    setDeleting(inst.id);
    try {
      await remove(inst.id);
      add({ type: 'info', title: t('versions.instance_deleted'), message: t('versions.instance_removed', { name: inst.name }), duration: 3000 });
    } catch (e) {
      add({ type: 'error', title: t('versions.delete_failed'), message: String(e), duration: 4000 });
    } finally {
      setDeleting(null);
    }
  };

  // Which loaders are already installed for each version (one instance per loader).
  const installedByVersion = useMemo(() => {
    const map = new Map<string, MinecraftInstance[]>();
    for (const i of instances) {
      const arr = map.get(i.mcVersion) || [];
      arr.push(i);
      map.set(i.mcVersion, arr);
    }
    return map;
  }, [instances]);

  return (
    <div className="catalog-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('versions.title')}</h1>
          <p className="page-subtitle">{t('versions.subtitle')}</p>
        </div>
      </div>

      <div className="catalog-toolbar">
        <div className="search-box">
          <Search size={16} />
          <input placeholder={t('versions.search')} value={query} onChange={(e) => { setQuery(e.target.value); setVisibleCount(PAGE_SIZE); }} />
        </div>
      </div>

      <div className="category-strip">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            className={`category-chip ${filter === f.id ? 'category-chip-active' : ''}`}
            onClick={() => { setFilter(f.id); setVisibleCount(PAGE_SIZE); }}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading ? (
        <LoadingState label={t('versions.checking')} />
      ) : filtered.length === 0 ? (
        <EmptyState title={t('versions.no_versions')} description={t('versions.no_versions_desc')} />
      ) : (
        <>
          <div className="version-grid">
            {visible.map((version) => {
              const installed = installedByVersion.get(version.id) || [];
              const installedLoaders = new Set(installed.map((i) => i.loader));
              const allLoadersInstalled = LOADERS.every((l) => installedLoaders.has(l.id));
              return (
                <div className="card version-card" key={version.id}>
                  <div className="version-icon"><Layers size={20} /></div>
                  <div>
                    <h3>{t('versions.minecraft_version', { id: version.id })}</h3>
                    <span className="text-muted">{typeLabel(version.type)}</span>
                  </div>
                  {installed.length > 0 ? (
                    <div className="version-card-actions version-card-actions-wrap">
                      <div className="version-installed-row">
                        {installed.map((inst) => (
                          <span key={inst.id} className="version-installed-tag">
                            <Check size={12} /> {inst.loader !== 'vanilla' ? inst.loader : 'vanilla'}
                            <button
                              className="version-tag-remove"
                              title={`Delete ${inst.name}`}
                              disabled={deleting === inst.id}
                              onClick={() => deleteVersion(inst)}
                            >
                              <Trash2 size={11} />
                            </button>
                          </span>
                        ))}
                      </div>
                      {!allLoadersInstalled && (
                        <Button
                          variant="secondary"
                          size="sm"
                          icon={<Download size={14} />}
                          onClick={() => openInstall(version)}
                        >
                          {t('versions.add_loader')}
                        </Button>
                      )}
                    </div>
                  ) : (
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={<Download size={14} />}
                      onClick={() => openInstall(version)}
                    >
                      {t('versions.install_action')}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
          {visibleCount < filtered.length && (
            <div className="load-more-wrap">
              <Button variant="secondary" onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}>
                {t('versions.load_more', { count: String(filtered.length - visibleCount) })}
              </Button>
            </div>
          )}
        </>
      )}

      {/* Install modal */}
      <AnimatePresence>
        {install && (
          <motion.div
            className="modal-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => { if (!install.running) setInstall(null); }}
          >
            <motion.div
              className="modal"
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              transition={{ duration: 0.25 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="modal-header">
                <h2>{t('versions.install_minecraft', { id: install.version.id })}</h2>
                <button className="modal-close" onClick={() => { if (!install.running) setInstall(null); }}><X size={16} /></button>
              </div>
              <div className="modal-body">
                <label className="input-label">{t('versions.mod_loader')}</label>
                <div className="loader-pills">
                  {LOADERS.map((l) => {
                    const known = install.available[l.id] !== undefined;
                    const unavailable = !install.checking && known && l.id !== 'vanilla' && !install.available[l.id];
                    const alreadyInstalled = install.installedLoaders.has(l.id);
                    const disabled = unavailable || alreadyInstalled;
                    return (
                      <button
                        key={l.id}
                        className={`loader-pill ${install.loader === l.id ? 'loader-pill-active' : ''} ${disabled ? 'loader-pill-disabled' : ''}`}
                        disabled={disabled || install.running}
                        title={alreadyInstalled ? 'Already installed for this version' : undefined}
                        onClick={() => setInstall((prev) => (prev ? { ...prev, loader: l.id } : prev))}
                      >
                        {l.label}
                        {install.checking && <span className="loader-pill-dot" />}
                        {alreadyInstalled && <span className="loader-pill-installed">✓ installed</span>}
                        {!install.checking && !disabled && l.id !== 'vanilla' && <span className="loader-pill-ok">✓</span>}
                        {unavailable && <span className="loader-pill-no">—</span>}
                      </button>
                    );
                  })}
                </div>
                {install.installedLoaders.size > 0 && (
                  <p className="install-hint">{t('versions.loaders_hint')}</p>
                )}
                {install.checking && <p className="install-hint">{t('versions.checking_loaders_hint')}</p>}
                {!install.checking && install.loader !== 'vanilla' && !install.available[install.loader] && (
                  <p className="install-hint install-error-text">{t('versions.no_builds', { loader: install.loader })}</p>
                )}

                {install.running && (
                  <div className="install-progress">
                    <div className="install-progress-bar">
                      <div className="install-progress-fill" style={{ width: `${Math.max(install.progress * 100, 2)}%` }} />
                    </div>
                    <span className="install-progress-text">
                      {install.stage}
                      {install.eta && <span className="install-eta"> · {install.eta}</span>}
                    </span>
                  </div>
                )}

                {install.error && (
                  <div className="install-error-box">
                    <strong>{t('versions.installation_failed')}</strong>
                    <span>{install.error}</span>
                  </div>
                )}
              </div>
              <div className="modal-footer">
                <Button variant="ghost" disabled={install.running} onClick={() => setInstall(null)}>{t('versions.cancel')}</Button>
                <Button
                  variant="primary"
                  loading={install.running || install.checking}
                  disabled={!install.checking && install.loader !== 'vanilla' && !install.available[install.loader]}
                  icon={<Wrench size={15} />}
                  onClick={startInstall}
                >
                  {install.running ? install.stage || t('versions.installing') : t('versions.install_action')}
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

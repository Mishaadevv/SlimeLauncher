import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, Download, Star, User as UserIcon, Package, X, Check, Trash2, FolderOpen, RefreshCw, Image } from 'lucide-react';
import { useInstanceStore } from '@/store/instance-store';
import { useNotificationStore } from '@/store/notification-store';
import { useSettingsStore } from '@/store/settings-store';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { LoadingState } from '@/components/LoadingState';
import { EmptyState } from '@/components/EmptyState';
import { t } from '@/lib/i18n';
import type { ModrinthMod, ModrinthVersion, ModEntry } from '@shared/types';
import { GAME_VERSIONS } from '@/lib/game-versions';
import './ModsPage.css';

const CATEGORIES = [
  'optimization', 'adventure', 'technology', 'magic', 'worldgen', 'mobs',
  'building', 'decoration', 'utility', 'performance', 'horror', 'rpg',
];

const SORTS = [
  { id: 'relevance', label: 'Relevance' },
  { id: 'downloads', label: 'Most downloaded' },
  { id: 'updated', label: 'Recently updated' },
];

const SOURCES = [
  { id: 'curseforge', label: 'CurseForge' },
  { id: 'modrinth', label: 'Modrinth' },
] as const;

type ModSource = 'curseforge' | 'modrinth';

interface ModCard extends ModrinthMod {
  icon_url: string | null;
}

export function ModsPage() {
  const { instances, selectedId } = useInstanceStore();
  const { add } = useNotificationStore();
  const { settings } = useSettingsStore();
  const anim = settings.animationsEnabled && !settings.reducedMotion;

  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [sort, setSort] = useState('relevance');
  const [gameVersion, setGameVersion] = useState('');
  const [source, setSource] = useState<ModSource>('curseforge');
  const [mods, setMods] = useState<ModCard[]>([]);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(0);
  const pageRef = useRef(0);
  const [hasMore, setHasMore] = useState(true);
  const [installing, setInstalling] = useState<string | null>(null);
  const [selectedMod, setSelectedMod] = useState<ModCard | null>(null);
  const [versions, setVersions] = useState<ModrinthVersion[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [screenshots, setScreenshots] = useState<Array<{ url: string; caption: string }>>([]);
  const [screenshotsLoading, setScreenshotsLoading] = useState(false);
  const [screenshotsPage, setScreenshotsPage] = useState(0);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const searchGenRef = useRef(0);
  const [installedSlugs, setInstalledSlugs] = useState<Set<string>>(new Set());
  const [installedMods, setInstalledMods] = useState<ModEntry[]>([]);
  const [installedLoading, setInstalledLoading] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);
  const [updatingAll, setUpdatingAll] = useState(false);

  const selectedInstance = instances.find((i) => i.id === selectedId) || null;
  // Mods require a loader (Fabric/Forge/NeoForge/Quilt) — vanilla instances
  // have no modding API and would silently ignore the jars.
  const isVanilla = selectedInstance?.loader === 'vanilla';

  // Game-version catalog filter, defaulting to the selected instance's version.
  const versionOptions = useMemo(() => {
    const list = [...GAME_VERSIONS];
    const instVer = selectedInstance?.mcVersion;
    if (instVer && !list.includes(instVer)) list.unshift(instVer);
    return list;
  }, [selectedInstance?.mcVersion]);
  useEffect(() => {
    if (selectedInstance?.mcVersion) setGameVersion(selectedInstance.mcVersion);
  }, [selectedInstance?.id]);

  const loadInstalled = useCallback(async () => {
    if (!selectedInstance) { setInstalledMods([]); setInstalledSlugs(new Set()); return; }
    setInstalledLoading(true);
    try {
      const list: ModEntry[] = (await window.slime.mod.list(selectedInstance.id)) || [];
      setInstalledMods(list);
      setInstalledSlugs(new Set(list.map((m) => m.slug)));
    } catch {
      setInstalledMods([]);
      setInstalledSlugs(new Set());
    } finally {
      setInstalledLoading(false);
    }
  }, [selectedInstance]);

  useEffect(() => { void loadInstalled(); }, [loadInstalled, selectedId]);

  const doSearch = useCallback(async (reset = false) => {
    const gen = ++searchGenRef.current;
    const nextPage = reset ? 0 : pageRef.current;
    setLoading(true);
    try {
      const facets: string[] = [];
      if (category) facets.push(`categories:${category}`);
      const res = source === 'modrinth'
        ? await window.slime.mod.searchModrinth(query, facets, nextPage, sort, gameVersion)
        : await window.slime.mod.search(query, facets, nextPage, sort, gameVersion);
      if (gen !== searchGenRef.current) return;
      const hits = (res.hits || []) as ModCard[];
      setMods((prev) => (reset ? hits : [...prev, ...hits]));
      setHasMore((nextPage + 1) * 20 < res.total);
      const newPage = reset ? 1 : nextPage + 1;
      setPage(newPage);
      pageRef.current = newPage;
    } catch (e) {
      if (gen !== searchGenRef.current) return;
      add({ type: 'error', title: t('mods.search_failed'), message: String(e), duration: 4000 });
    } finally {
      if (gen === searchGenRef.current) setLoading(false);
    }
  }, [query, category, sort, source, gameVersion, add]);

  // Debounced search on query/category/sort/source change
  useEffect(() => {
    pageRef.current = 0;
    setPage(0);
    setMods([]);
    const gen = ++searchGenRef.current;
    setLoading(true);
    const tt = setTimeout(async () => {
      try {
        const facets: string[] = [];
        if (category) facets.push(`categories:${category}`);
        const res = source === 'modrinth'
          ? await window.slime.mod.searchModrinth(query, facets, 0, sort, gameVersion)
          : await window.slime.mod.search(query, facets, 0, sort, gameVersion);
        if (gen !== searchGenRef.current) return;
        const hits = (res.hits || []) as ModCard[];
        setMods(hits);
        setHasMore(20 < res.total);
        setPage(1);
        pageRef.current = 1;
      } catch (e) {
        if (gen !== searchGenRef.current) return;
        add({ type: 'error', title: t('mods.search_failed'), message: String(e), duration: 4000 });
      } finally {
        if (gen === searchGenRef.current) setLoading(false);
      }
    }, 400);
    return () => clearTimeout(tt);
  }, [query, category, sort, source, gameVersion, add]);

  // Infinite scroll
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && !loading && hasMore) {
        doSearch();
      }
    }, { rootMargin: '200px' });
    obs.observe(el);
    return () => obs.disconnect();
  }, [doSearch, loading, hasMore]);

  const openMod = async (mod: ModCard) => {
    setSelectedMod(mod);
    setVersionsLoading(true);
    setVersions([]);
    setScreenshots([]);
    setScreenshotsPage(0);
    setScreenshotsLoading(true);
    try {
      const mcVersion = selectedInstance?.mcVersion || '1.20.1';
      const loader = selectedInstance?.loader && selectedInstance.loader !== 'vanilla'
        ? selectedInstance.loader
        : '';
      const [v, screens] = await Promise.all([
        source === 'modrinth'
          ? window.slime.mod.versionsModrinth(mod.slug, mcVersion, loader)
          : window.slime.mod.versions(mod.slug, mcVersion, loader, mod.project_id),
        window.slime.mod.screens(mod.project_id, source),
      ]);
      setVersions(v || []);
      setScreenshots(screens || []);
    } catch {
      setVersions([]);
      setScreenshots([]);
    } finally {
      setVersionsLoading(false);
      setScreenshotsLoading(false);
    }
  };

  const installMod = async (mod: ModCard, version: ModrinthVersion) => {
    if (!selectedInstance) {
      add({ type: 'warning', title: t('mods.no_instance'), message: t('mods.no_instance_desc'), duration: 4000 });
      return;
    }
    if (selectedInstance.loader === 'vanilla') {
      add({ type: 'warning', title: t('mods.vanilla_instance'), message: t('mods.vanilla_instance_desc'), duration: 5000 });
      return;
    }
    const file = version.files.find((f) => f.primary) || version.files[0];
    if (!file || !file.url) {
      add({ type: 'error', title: t('mods.download_unavailable'), message: t('mods.download_unavailable_desc'), duration: 4000 });
      return;
    }
    setInstalling(mod.project_id);
    try {
      const res = source === 'modrinth'
        ? await window.slime.mod.installModrinth({
            instanceId: selectedInstance.id,
            slug: mod.slug,
            name: mod.title,
            author: mod.author,
            versionId: version.id,
            versionNumber: version.version_number,
            fileUrl: file.url,
            fileName: file.filename,
          })
        : await window.slime.mod.install({
            instanceId: selectedInstance.id,
            slug: mod.slug,
            name: mod.title,
            author: mod.author,
            versionId: version.id,
            versionNumber: version.version_number,
            fileUrl: file.url,
            fileName: file.filename,
            source: 'curseforge',
          });
      if (res.ok) {
        add({ type: 'success', title: t('mods.mod_installed'), message: t('mods.mod_installed_desc', { name: mod.title }), duration: 4000 });
        setInstalledSlugs((prev) => new Set([...prev, mod.slug]));
        setSelectedMod(null);
        void loadInstalled();
      }
    } catch (e) {
      add({ type: 'error', title: t('mods.install_failed'), message: String(e), duration: 4000 });
    } finally {
      setInstalling(null);
    }
  };

  const toggleMod = async (mod: ModEntry) => {
    setToggling(mod.id);
    try {
      await window.slime.mod.toggle(mod.id, !mod.enabled);
      setInstalledMods((list) => list.map((m) => m.id === mod.id ? { ...m, enabled: !mod.enabled } : m));
    } catch (e) {
      add({ type: 'error', title: t('mods.toggle_failed'), message: String(e), duration: 3500 });
    } finally {
      setToggling(null);
    }
  };

  const deleteMod = async (mod: ModEntry) => {
    try {
      await window.slime.mod.delete(mod.id);
      setInstalledMods((list) => list.filter((m) => m.id !== mod.id));
      setInstalledSlugs((prev) => {
        const next = new Set(prev);
        next.delete(mod.slug);
        return next;
      });
      add({ type: 'info', title: t('mods.mod_removed'), message: t('mods.mod_removed_desc', { name: mod.name }), duration: 3000 });
    } catch (e) {
      add({ type: 'error', title: t('mods.remove_failed'), message: String(e), duration: 3500 });
    }
  };

  const updateAllMods = async () => {
    if (!selectedInstance || updatingAll) return;
    setUpdatingAll(true);
    try {
      const res = await window.slime.mod.updateAll(selectedInstance.id) as { ok: boolean; error?: string; updated?: number; upToDate?: number; failed?: number; errors?: string[] };
      if (!res.ok) {
        add({ type: 'error', title: t('mods.update_failed'), message: res.error || t('common.unknown_error'), duration: 5000 });
      } else {
        const parts = [
          `${t('mods.updated_count', { count: String(res.updated || 0) })}`,
          `${t('mods.uptodate_count', { count: String(res.upToDate || 0) })}`,
        ];
        if ((res.failed || 0) > 0) parts.push(`${t('mods.failed_count', { count: String(res.failed || 0) })}`);
        add(
          (res.failed || 0) > 0
            ? { type: 'warning', title: t('mods.update_done_title'), message: parts.join(' · '), duration: 6000 }
            : { type: 'success', title: t('mods.update_done_title'), message: parts.join(' · '), duration: 5000 },
        );
        await loadInstalled();
      }
    } catch (e) {
      add({ type: 'error', title: t('mods.update_failed'), message: String(e), duration: 5000 });
    } finally {
      setUpdatingAll(false);
    }
  };

  const openModsFolder = () => {
    if (selectedInstance) window.slime.instance.openFolder(selectedInstance.id);
  };

  return (
    <div className="mods-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('mods.title')}</h1>
          <p className="page-subtitle">
            {selectedInstance ? t('mods.installing_into', { name: selectedInstance.name }) : t('mods.select_instance')}
          </p>
        </div>
        <div className="page-header-actions">
          <Button variant="secondary" size="sm" icon={<FolderOpen size={15} />} onClick={openModsFolder}>{t('mods.open_folder')}</Button>
        </div>
      </div>

      {selectedInstance && (
        <section className="installed-section">
          <div className="section-heading">
            <div>
              <h2>{t('mods.installed_in', { name: selectedInstance.name })}</h2>
              <p>{installedLoading ? t('mods.refreshing') : installedMods.length === 1 ? t('mods.mods_count', { count: String(installedMods.length) }) : t('mods.mods_count_plural', { count: String(installedMods.length) })}</p>
            </div>
            <Button variant="ghost" size="sm" icon={<RefreshCw size={14} />} onClick={() => void loadInstalled()}>{t('mods.refresh')}</Button>
            {installedMods.length > 0 && (
              <Button
                variant="secondary"
                size="sm"
                icon={<Download size={14} />}
                loading={updatingAll}
                disabled={updatingAll}
                onClick={() => void updateAllMods()}
              >
                {t('mods.update_all')}
              </Button>
            )}
          </div>
          {installedMods.length === 0 && !installedLoading ? (
            <div className="installed-empty">{t('mods.no_mods')}</div>
          ) : (
            <div className="installed-list">
              {installedMods.map((mod) => (
                <div className="installed-item" key={mod.id}>
                  <div className="installed-map-icon" style={{ opacity: mod.enabled ? 1 : 0.4 }}>
                    <Package size={17} />
                  </div>
                  <div className="installed-map-info" style={{ opacity: mod.enabled ? 1 : 0.55 }}>
                    <strong>{mod.name}</strong>
                    <span>{mod.source} · {mod.version}</span>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={toggling === mod.id}
                    icon={mod.enabled ? <Check size={14} /> : <X size={14} />}
                    onClick={() => void toggleMod(mod)}
                    aria-label={mod.enabled ? 'Disable mod' : 'Enable mod'}
                  >
                    {mod.enabled ? 'On' : 'Off'}
                  </Button>
                  <Button variant="ghost" size="sm" icon={<Trash2 size={14} />} onClick={() => void deleteMod(mod)} aria-label="Remove mod" />
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {isVanilla && selectedInstance && (
        <div className="vanilla-mods-notice">
          <Package size={18} />
          <div>
            <strong>{t('mods.vanilla_title', { name: selectedInstance.name })}</strong>
            <span>{t('mods.vanilla_desc')}</span>
          </div>
        </div>
      )}

      {!isVanilla && (
        <>
          <div className="catalog-toolbar">
            <div className="search-box">
              <Search size={16} />
              <input
                placeholder={t('mods.search_placeholder')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {query && (
                <button className="search-clear" onClick={() => setQuery('')}>
                  <X size={14} />
                </button>
              )}
            </div>
            <div className="source-pills">
              {SOURCES.map((s) => (
                <button
                  key={s.id}
                  className={`source-pill ${source === s.id ? 'source-pill-active' : ''}`}
                  onClick={() => setSource(s.id)}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <select className="select" value={sort} onChange={(e) => setSort(e.target.value)}>
              {SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
            <select className="select" value={gameVersion} onChange={(e) => setGameVersion(e.target.value)} aria-label="Game version">
              <option value="">{t('mods.all_versions')}</option>
              {versionOptions.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>

          <div className="category-strip">
            <button
              className={`category-chip ${category === null ? 'category-chip-active' : ''}`}
              onClick={() => setCategory(null)}
            >
              {t('mods.all_label')}
            </button>
            {CATEGORIES.map((c) => (
              <button
                key={c}
                className={`category-chip ${category === c ? 'category-chip-active' : ''}`}
                onClick={() => setCategory(category === c ? null : c)}
              >
                {c}
              </button>
            ))}
          </div>
        </>
      )}

      {isVanilla ? null : loading && mods.length === 0 ? (
        <LoadingState label={t('mods.loading_mods')} />
      ) : isVanilla ? null : mods.length === 0 ? (
        <EmptyState
          title={t('mods.no_mods_found')}
          description={t('mods.try_different')}
        />
      ) : (
        <div className="mods-grid">
          <AnimatePresence>
            {mods.map((mod) => (
              <motion.div
                key={`${source}-${mod.project_id}`}
                layout
                initial={anim ? { opacity: 0, y: 12 } : false}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ duration: 0.2 }}
              >
                <Card hover interactive className="mod-card" onClick={() => openMod(mod)}>
                  <div className="mod-card-icon">
                    {mod.icon_url ? <img src={mod.icon_url} alt="" loading="lazy" /> : <Package size={24} />}
                  </div>
                  <div className="mod-card-body">
                    <h3 className="mod-card-title">{mod.title}</h3>
                    <p className="mod-card-desc">{mod.description}</p>
                    <div className="mod-card-meta">
                      <span><UserIcon size={12} /> {mod.author}</span>
                      <span><Download size={12} /> {formatDownloads(mod.downloads)}</span>
                      {installedSlugs.has(mod.slug) && (
                        <span className="mod-tag"><Check size={11} /> {t('mods.installed_badge')}</span>
                      )}
                      {mod.categories?.slice(0, 2).map((c) => (
                        <span key={c} className="mod-tag">{c}</span>
                      ))}
                    </div>
                  </div>
                </Card>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}

      <div ref={sentinelRef} className="sentinel" />

      <AnimatePresence>
        {selectedMod && (
          <motion.div
            className="modal-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setSelectedMod(null)}
          >
            <motion.div
              className="modal mod-detail"
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              transition={{ duration: 0.25 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="modal-header">
                <div className="mod-detail-title">
                  {selectedMod.icon_url && <img src={selectedMod.icon_url} alt="" className="mod-detail-icon" />}
                  <div>
                    <h2>{selectedMod.title}</h2>
                    <div className="mod-detail-author">by {selectedMod.author}</div>
                  </div>
                </div>
                <button className="modal-close" onClick={() => setSelectedMod(null)}><X size={16} /></button>
              </div>
              <div className="modal-body">
                <p className="mod-detail-desc">{selectedMod.description}</p>
                <div className="mod-detail-stats">
                  <span><Download size={14} /> {formatDownloads(selectedMod.downloads)} downloads</span>
                  <span><Star size={14} /> {selectedMod.categories?.join(', ') || 'General'}</span>
                </div>
                <h4 className="mod-versions-title">{t('mods.screenshots')}</h4>
                {screenshotsLoading ? (
                  <LoadingState label={t('common.loading')} size="sm" />
                ) : screenshots.length > 0 ? (
                  <div className="mod-gallery">
                    {screenshots.map((s, i) => (
                      <div key={i} className="mod-gallery-item">
                        <img src={s.url} alt={s.caption || `Screenshot ${i + 1}`} loading="lazy" />
                        {s.caption && <span className="mod-gallery-caption">{s.caption}</span>}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="mod-no-versions">{t('mods.no_screenshots')}</div>
                )}
                <h4 className="mod-versions-title">{t('mods.available_versions')}</h4>
                {versionsLoading ? (
                  <LoadingState label={t('common.loading')} size="sm" />
                ) : versions.length === 0 ? (
                  <div className="mod-no-versions">{t('mods.no_compatible')}</div>
                ) : (
                  <div className="mod-versions-list">
                    {versions.slice(0, 8).map((v) => {
                      const file = v.files.find((f) => f.primary) || v.files[0];
                      return (
                        <div key={v.id} className="mod-version-row">
                          <div>
                            <div className="mod-version-name">{v.version_number}</div>
                            <div className="mod-version-meta">
                              {v.game_versions?.slice(0, 3).join(', ')} · {v.loaders?.join(', ')}
                            </div>
                          </div>
                          <Button
                            variant="primary"
                            size="sm"
                            icon={<Download size={14} />}
                            loading={installing === selectedMod.project_id}
                            onClick={() => installMod(selectedMod, v)}
                          >
                            {t('mods.install_btn')}
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function formatDownloads(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

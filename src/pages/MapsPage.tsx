import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, Download, User as UserIcon, Map as MapIcon, FolderOpen, Trash2, RefreshCw, X } from 'lucide-react';
import type { MapEntry } from '@shared/types';
import { useInstanceStore } from '@/store/instance-store';
import { useNotificationStore } from '@/store/notification-store';
import { useSettingsStore } from '@/store/settings-store';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { LoadingState } from '@/components/LoadingState';
import { EmptyState } from '@/components/EmptyState';
import { t } from '@/lib/i18n';
import { GAME_VERSIONS } from '@/lib/game-versions';
import './ModsPage.css';

const CATEGORIES = [
  'adventure', 'survival', 'creative', 'parkour', 'puzzle', 'minigame', 'quests', 'challenging',
];

const SORTS = [
  { id: 'relevance', label: 'Relevance' },
  { id: 'popularity', label: 'Most popular' },
  { id: 'updated', label: 'Recently updated' },
];

interface MapItem {
  project_id?: string;
  slug?: string;
  title?: string;
  name?: string;
  description?: string;
  author?: string;
  downloads?: number;
  icon_url?: string;
  image_url?: string;
  categories?: string[];
}

function formatDownloads(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function MapsPage() {
  const { instances, selectedId } = useInstanceStore();
  const { add } = useNotificationStore();
  const { settings } = useSettingsStore();
  const anim = settings.animationsEnabled && !settings.reducedMotion;

  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [sort, setSort] = useState('relevance');
  const [gameVersion, setGameVersion] = useState('');
  const [maps, setMaps] = useState<MapItem[]>([]);
  const [loading, setLoading] = useState(false);
  const pageRef = useRef(0);
  const [hasMore, setHasMore] = useState(true);
  const [installing, setInstalling] = useState<string | null>(null);
  const [selectedMap, setSelectedMap] = useState<MapItem | null>(null);
  const [screenshots, setScreenshots] = useState<Array<{ url: string; caption: string }>>([]);
  const [screenshotsLoading, setScreenshotsLoading] = useState(false);
  const [installed, setInstalled] = useState<MapEntry[]>([]);
  const [installedLoading, setInstalledLoading] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const searchGenRef = useRef(0);

  const selectedInstance = instances.find((item) => item.id === selectedId) || null;

  // Game-version catalog filter, defaulting to the selected instance's version.
  const versionOptions = useMemo(() => {
    const list = [...GAME_VERSIONS];
    const instVer = selectedInstance?.mcVersion;
    if (instVer && !list.includes(instVer)) list.unshift(instVer);
    return list;
  }, [selectedInstance?.mcVersion]);
  useEffect(() => {
    if (selectedInstance?.mcVersion) setGameVersion(selectedInstance.mcVersion);
  }, [selectedInstance?.mcVersion]);

  const loadInstalled = useCallback(async () => {
    if (!selectedInstance) { setInstalled([]); return; }
    setInstalledLoading(true);
    try { setInstalled(await window.slime.map.list(selectedInstance.id)); }
    catch (e) { add({ type: 'error', title: t('maps.load_failed'), message: String(e), duration: 3500 }); }
    finally { setInstalledLoading(false); }
  }, [selectedInstance, add]);

  useEffect(() => { void loadInstalled(); }, [loadInstalled]);

  const doSearch = useCallback(async (reset = false) => {
    const gen = ++searchGenRef.current;
    const nextPage = reset ? 0 : pageRef.current;
    setLoading(true);
    try {
      const result = await window.slime.map.search(query, category || '', nextPage, sort, gameVersion);
      if (gen !== searchGenRef.current) return;
      const hits = ((result?.hits) || []) as MapItem[];
      setMaps((prev) => (reset ? hits : [...prev, ...hits]));
      setHasMore((nextPage + 1) * 20 < (result?.total || 0));
      pageRef.current = reset ? 1 : nextPage + 1;
    } catch (e) {
      if (gen !== searchGenRef.current) return;
      add({ type: 'error', title: t('maps.search_failed'), message: String(e), duration: 4000 });
    } finally { if (gen === searchGenRef.current) setLoading(false); }
  }, [query, category, sort, gameVersion, add]);

  // Debounced search on query/category/sort change
  useEffect(() => {
    pageRef.current = 0;
    setMaps([]);
    const gen = ++searchGenRef.current;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const result = await window.slime.map.search(query, category || '', 0, sort, gameVersion);
        if (gen !== searchGenRef.current) return;
        const hits = ((result?.hits) || []) as MapItem[];
        setMaps(hits);
        setHasMore(20 < (result?.total || 0));
        pageRef.current = 1;
      } catch (e) {
        if (gen !== searchGenRef.current) return;
        add({ type: 'error', title: t('maps.search_failed'), message: String(e), duration: 4000 });
      } finally { if (gen === searchGenRef.current) setLoading(false); }
    }, 400);
    return () => clearTimeout(timer);
  }, [query, category, sort, gameVersion, add]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && !loading && hasMore) doSearch();
    }, { rootMargin: '200px' });
    obs.observe(el);
    return () => obs.disconnect();
  }, [doSearch, loading, hasMore]);

  const installMap = async (map: MapItem) => {
    if (!selectedInstance) {
      add({ type: 'warning', title: t('maps.no_instance'), message: t('maps.no_instance_desc'), duration: 3500 });
      return;
    }
    const id = map.project_id || map.slug || '';
    setInstalling(id);
    try {
      const result = await window.slime.map.install({
        instanceId: selectedInstance.id,
        mapId: id,
        name: map.title || map.name || 'Minecraft map',
        author: map.author || 'Community',
        mapType: 'Adventure',
      });
      if (result.ok !== false) {
        add({ type: 'success', title: t('maps.install_started'), message: t('maps.install_started_desc', { name: String(map.title || map.name || ''), instance: selectedInstance.name }), duration: 4000 });
        setTimeout(() => { void loadInstalled(); }, 2000);
      } else if (result.error) {
        add({ type: 'error', title: t('maps.install_failed'), message: String(result.error), duration: 4000 });
      }
    } catch (e) { add({ type: 'error', title: t('maps.install_failed'), message: String(e), duration: 4000 }); }
    finally { setInstalling(null); }
  };

  const removeInstalled = async (map: MapEntry) => {
    try {
      await window.slime.map.delete(map.id);
      setInstalled((items) => items.filter((item) => item.id !== map.id));
      add({ type: 'info', title: t('maps.map_removed'), message: t('maps.map_removed_desc', { name: map.name }), duration: 3000 });
    } catch (e) { add({ type: 'error', title: t('maps.remove_failed'), message: String(e), duration: 3500 }); }
  };

  const openMapsFolder = async () => {
    if (installed[0]) await window.slime.map.openFolder(installed[0].id);
    else if (selectedInstance) add({ type: 'info', title: t('maps.no_maps_installed'), message: t('maps.no_maps_installed_desc'), duration: 3000 });
  };

  const openMap = async (map: MapItem) => {
    setSelectedMap(map);
    setScreenshots([]);
    setScreenshotsLoading(true);
    try {
      const pid = map.project_id || '';
      if (pid) {
        const screens = await window.slime.map.screens(pid);
        setScreenshots(screens || []);
      }
    } catch {
      setScreenshots([]);
    } finally {
      setScreenshotsLoading(false);
    }
  };

  return (
    <div className="mods-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('maps.title2')}</h1>
          <p className="page-subtitle">
            {selectedInstance ? t('maps.installing_into', { name: selectedInstance.name }) : t('maps.select_instance')}
          </p>
        </div>
        <div className="page-header-actions">
          <Button variant="secondary" size="sm" icon={<FolderOpen size={15} />} onClick={openMapsFolder}>{t('common.open')}</Button>
        </div>
      </div>

      {selectedInstance && (
        <section className="installed-section">
          <div className="section-heading">
            <div>
              <h2>{t('maps.installing_into', { name: selectedInstance.name })}</h2>
              <p>{installedLoading ? t('mods.refreshing') : `${installed.length} map${installed.length === 1 ? '' : 's'} in this instance.`}</p>
            </div>
            <Button variant="ghost" size="sm" icon={<RefreshCw size={14} />} onClick={() => void loadInstalled()}>{t('mods.refresh')}</Button>
          </div>
          {installed.length === 0 && !installedLoading ? (
            <div className="installed-empty">No installed maps yet. Browse the catalog below.</div>
          ) : (
            <div className="installed-list">
              {installed.map((map) => (
                <div className="installed-item" key={map.id}>
                  <div className="installed-map-icon"><MapIcon size={17} /></div>
                  <div className="installed-map-info">
                    <strong>{map.name}</strong>
                    <span>{map.mapType} · {map.author}</span>
                  </div>
                  <Button variant="ghost" size="sm" icon={<FolderOpen size={14} />} onClick={() => window.slime.map.openFolder(map.id)} aria-label="Open saves folder" />
                  <Button variant="ghost" size="sm" icon={<Trash2 size={14} />} onClick={() => void removeInstalled(map)} aria-label="Remove map" />
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <div className="catalog-toolbar">
        <div className="search-box">
          <Search size={16} />
          <input placeholder="Search maps and worlds..." value={query} onChange={(e) => setQuery(e.target.value)} />
          {query && (
            <button className="search-clear" onClick={() => setQuery('')}>
              <X size={14} />
            </button>
          )}
        </div>
        <div className="source-pills">
          <span className="source-pill source-pill-static">CurseForge</span>
        </div>
        <select className="select" value={sort} onChange={(e) => setSort(e.target.value)}>
          {SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
        <select className="select" value={gameVersion} onChange={(e) => setGameVersion(e.target.value)} aria-label="Game version">
          <option value="">All versions</option>
          {versionOptions.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
      </div>

      <div className="category-strip">
        <button className={`category-chip ${category === null ? 'category-chip-active' : ''}`} onClick={() => setCategory(null)}>All</button>
        {CATEGORIES.map((c) => (
          <button key={c} className={`category-chip ${category === c ? 'category-chip-active' : ''}`} onClick={() => setCategory(category === c ? null : c)}>{c}</button>
        ))}
      </div>

      {loading && maps.length === 0 ? (
        <LoadingState label="Exploring maps..." />
      ) : maps.length === 0 ? (
        <EmptyState title="No maps found" description="Try a different search or category." />
      ) : (
        <div className="mods-grid">
          {maps.map((map) => {
            const id = map.project_id || map.slug || map.title || '';
            return (
              <motion.div key={id} layout initial={anim ? { opacity: 0, y: 12 } : false} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}>
                <Card hover interactive className="mod-card" onClick={() => openMap(map)}>
                  <div className="mod-card-icon">
                    {map.icon_url || map.image_url ? <img src={map.icon_url || map.image_url} alt="" loading="lazy" /> : <MapIcon size={24} />}
                  </div>
                  <div className="mod-card-body">
                    <h3 className="mod-card-title">{map.title || map.name}</h3>
                    <p className="mod-card-desc">{map.description || 'A community-made Minecraft map.'}</p>
                    <div className="mod-card-meta">
                      <span><UserIcon size={12} /> {map.author || 'Community'}</span>
                      <span><Download size={12} /> {formatDownloads(map.downloads || 0)}</span>
                      {map.categories?.slice(0, 2).map((c) => <span key={c} className="mod-tag">{c}</span>)}
                    </div>
                  </div>
                </Card>
              </motion.div>
            );
          })}
        </div>
      )}

      <div ref={sentinelRef} className="sentinel" />

      <AnimatePresence>
        {selectedMap && (
          <motion.div
            className="modal-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setSelectedMap(null)}
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
                  {(selectedMap.icon_url || selectedMap.image_url) && (
                    <img src={selectedMap.icon_url || selectedMap.image_url} alt="" className="mod-detail-icon" />
                  )}
                  <div>
                    <h2>{selectedMap.title || selectedMap.name}</h2>
                    <div className="mod-detail-author">by {selectedMap.author || 'Community'}</div>
                  </div>
                </div>
                <button className="modal-close" onClick={() => setSelectedMap(null)}><X size={16} /></button>
              </div>
              <div className="modal-body">
                <p className="mod-detail-desc">{selectedMap.description || 'A community-made Minecraft map.'}</p>
                <div className="mod-detail-stats">
                  <span><Download size={14} /> {formatDownloads(selectedMap.downloads || 0)} downloads</span>
                  <span><UserIcon size={14} /> {selectedMap.author || 'Community'}</span>
                  {selectedMap.categories?.slice(0, 3).map((c) => <span key={c} className="mod-tag">{c}</span>)}
                </div>
                <h4 className="mod-versions-title">Screenshots</h4>
                {screenshotsLoading ? (
                  <LoadingState label="Loading screenshots..." size="sm" />
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
                  <div className="mod-no-versions">No screenshots available for this map.</div>
                )}
                <div style={{ marginTop: 16 }}>
                  <Button
                    variant="primary"
                    loading={installing === (selectedMap.project_id || selectedMap.slug || '')}
                    onClick={() => void installMap(selectedMap)}
                  >
                    Install Map
                  </Button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

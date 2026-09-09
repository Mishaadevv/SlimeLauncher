import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, Download, Star, User as UserIcon, Package, X } from 'lucide-react';
import { useInstanceStore } from '@/store/instance-store';
import { useNotificationStore } from '@/store/notification-store';
import { useSettingsStore } from '@/store/settings-store';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { LoadingState } from '@/components/LoadingState';
import { EmptyState } from '@/components/EmptyState';
import type { ModrinthMod, ModrinthVersion } from '@shared/types';
import { GAME_VERSIONS } from '@/lib/game-versions';
import './CatalogPages.css';

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

export function ModpacksPage() {
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
  const [, setPage] = useState(0);
  const pageRef = useRef(0);
  const [hasMore, setHasMore] = useState(true);
  const [installing, setInstalling] = useState<string | null>(null);
  const [selectedMod, setSelectedMod] = useState<ModCard | null>(null);
  const [versions, setVersions] = useState<ModrinthVersion[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [screenshots, setScreenshots] = useState<Array<{ url: string; caption: string }>>([]);
  const [screenshotsLoading, setScreenshotsLoading] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const searchGenRef = useRef(0);

  const selectedInstance = instances.find((i) => i.id === selectedId) || null;

  const versionOptions = useMemo(() => {
    const list = [...GAME_VERSIONS];
    const instVer = selectedInstance?.mcVersion;
    if (instVer && !list.includes(instVer)) list.unshift(instVer);
    return list;
  }, [selectedInstance?.mcVersion]);
  
  useEffect(() => {
    if (selectedInstance?.mcVersion) setGameVersion(selectedInstance.mcVersion);
  }, [selectedInstance?.mcVersion]);

  const doSearch = useCallback(async (reset = false) => {
    const gen = ++searchGenRef.current;
    const nextPage = reset ? 0 : pageRef.current;
    setLoading(true);
    try {
      const facets: string[] = ['project_type:modpack'];
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
      add({ type: 'error', title: 'Search failed', message: String(e), duration: 4000 });
    } finally {
      if (gen === searchGenRef.current) setLoading(false);
    }
  }, [query, category, sort, source, gameVersion, add]);

  useEffect(() => {
    pageRef.current = 0;
    setPage(0);
    setMods([]);
    const gen = ++searchGenRef.current;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const facets: string[] = ['project_type:modpack'];
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
        add({ type: 'error', title: 'Search failed', message: String(e), duration: 4000 });
      } finally {
        if (gen === searchGenRef.current) setLoading(false);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [query, category, sort, source, gameVersion, add]);

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
    setScreenshotsLoading(true);
    try {
      const mcVer = gameVersion || '';
      const [v, screens] = await Promise.all([
        source === 'modrinth'
          ? window.slime.mod.versionsModrinth(mod.slug, mcVer, '')
          : window.slime.mod.versions(mod.slug, mcVer, '', mod.project_id),
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

  const installModpack = async (mod: ModCard, version: ModrinthVersion) => {
    const file = version.files.find((f) => f.primary) || version.files[0];
    if (!file || !file.url) {
      add({ type: 'error', title: 'Download unavailable', message: 'This file has no download URL.', duration: 4000 });
      return;
    }
    setInstalling(mod.project_id);
    try {
      const res = await window.slime.modpack.install({
        source,
        name: mod.title,
        fileUrl: file.url,
      }) as { ok: boolean; error?: string };
      
      if (!res.ok) {
        add({ type: 'error', title: 'Install failed', message: res.error || 'Unknown error', duration: 4000 });
      }
    } catch (e) {
      add({ type: 'error', title: 'Install failed', message: String(e), duration: 4000 });
    } finally {
      setInstalling(null);
      setSelectedMod(null);
    }
  };

  return (
    <div className="catalog-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Modpacks</h1>
          <p className="page-subtitle">Browse and download ready-made modpacks.</p>
        </div>
      </div>

      <div className="catalog-toolbar">
        <div className="search-box">
          <Search size={16} />
          <input
            placeholder="Search modpacks..."
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
          <option value="">All versions</option>
          {versionOptions.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
      </div>

      <div className="category-strip">
        <button
          className={`category-chip ${category === null ? 'category-chip-active' : ''}`}
          onClick={() => setCategory(null)}
        >
          All
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

      {loading && mods.length === 0 ? (
        <LoadingState label="Loading modpacks..." />
      ) : mods.length === 0 ? (
        <EmptyState
          title="No modpacks found"
          description="Try a different search or category."
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
                  <div className="mod-no-versions">No screenshots available for this modpack.</div>
                )}
                <h4 className="mod-versions-title">Available versions</h4>
                {versionsLoading ? (
                  <LoadingState label="Loading versions..." size="sm" />
                ) : versions.length === 0 ? (
                  <div className="mod-no-versions">No versions found for this modpack.</div>
                ) : (
                  <div className="mod-versions-list">
                    {versions.slice(0, 8).map((v) => {
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
                            onClick={() => installModpack(selectedMod, v)}
                          >
                            Install
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
import { useCallback, useEffect, useState } from 'react';
import { Shirt, RefreshCw, Link2, Gamepad2, Sparkles, Upload, Trash2, User } from 'lucide-react';
import { Button } from '@/components/Button';
import { LoadingState } from '@/components/LoadingState';
import { EmptyState } from '@/components/EmptyState';
import { SkinViewer3D } from '@/components/SkinViewer3D';
import { Toggle } from '@/components/Toggle';
import { useNotificationStore } from '@/store/notification-store';
import { useAuthStore } from '@/store/auth-store';
import { useSettingsStore } from '@/store/settings-store';
import { MicrosoftLoginModal } from '@/components/MicrosoftLoginModal';
import { t } from '@/lib/i18n';
import './SkinsPage.css';

interface SkinProfile {
  uuid: string;
  username: string;
  skinUrl: string | null;
  skinVariant: string | null;
  capeUrl: string | null;
  skins: Array<{ id: string; state: string; url: string; variant: string }>;
  capes: Array<{ id: string; state: string; url: string }>;
}

interface OfflineSkin {
  username: string;
  variant: 'classic' | 'slim';
  hasSkin: boolean;
  hasCape: boolean;
  skinData: string | null;
  capeData: string | null;
  skinWidth: number | null;
  skinHeight: number | null;
  capeWidth: number | null;
  capeHeight: number | null;
  updatedAt: number;
}

// True when a texture is larger than the vanilla 64x64/64x32 grid.
function isHd(width: number | null, height: number | null, vanillaW: number, vanillaH: number): boolean {
  return !!width && !!height && (width > vanillaW || height > vanillaH);
}

function hdLabel(width: number | null, height: number | null): string | null {
  return width && height ? `${width}×${height}` : null;
}

// Shows the stored texture size, flagged "HD" when it exceeds the vanilla grid.
function SizeBadge({ w, h, vanillaW, vanillaH }: { w: number | null; h: number | null; vanillaW: number; vanillaH: number }) {
  const label = hdLabel(w, h);
  if (!label) return null;
  const hd = isHd(w, h, vanillaW, vanillaH);
  return <span className={`skin-badge ${hd ? 'skin-badge-hd' : ''}`}>{label}{hd ? ' HD' : ''}</span>;
}

export function SkinsPage() {
  const { add } = useNotificationStore();
  const { user, activeMicrosoft, loadMicrosoft } = useAuthStore();
  const { settings, load: loadSettings, update: updateSettings } = useSettingsStore();
  const hdMode = settings.hdTexturesInGame;
  const [showMsModal, setShowMsModal] = useState(false);
  const [profile, setProfile] = useState<SkinProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState<OfflineSkin | null>(null);
  const [offlineLoading, setOfflineLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadingCape, setUploadingCape] = useState(false);
  const [msCustom, setMsCustom] = useState<{ hasSkin: boolean; hasCape: boolean; skinData: string | null; capeData: string | null; variant: string; skinWidth: number | null; skinHeight: number | null; capeWidth: number | null; capeHeight: number | null } | null>(null);
  const [uploadingMsSkin, setUploadingMsSkin] = useState(false);
  const [uploadingMsCape, setUploadingMsCape] = useState(false);

  const loadProfile = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await window.slime.ms.profile();
      if (res.ok && res.profile) {
        setProfile(res.profile as SkinProfile);
      } else {
        setProfile(null);
        if (res.error) setError(res.error);
      }
    } catch (e) {
      setProfile(null);
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadOffline = useCallback(async () => {
    if (!user) { setOffline(null); return; }
    setOfflineLoading(true);
    try {
      const res = await window.slime.skin.get();
      if (res.ok && res.skin) setOffline(res.skin as OfflineSkin);
    } catch {
      setOffline(null);
    } finally {
      setOfflineLoading(false);
    }
  }, [user]);

  useEffect(() => { void loadSettings(); }, [loadSettings]);
  useEffect(() => { void loadProfile(); }, [loadProfile]);
  useEffect(() => { void loadOffline(); }, [loadOffline]);

  const loadMsCustom = useCallback(async () => {
    try {
      const res = await window.slime.ms.customSkin();
      if (res.ok && res.custom) setMsCustom(res.custom as { hasSkin: boolean; hasCape: boolean; skinData: string | null; capeData: string | null; variant: string; skinWidth: number | null; skinHeight: number | null; capeWidth: number | null; capeHeight: number | null });
      else setMsCustom(null);
    } catch {
      setMsCustom(null);
    }
  }, []);

  useEffect(() => { void loadMsCustom(); }, [loadMsCustom]);

  const toggleHdMode = async (v: boolean) => {
    try {
      await updateSettings({ hdTexturesInGame: v });
      add({
        type: v ? 'success' : 'info',
        title: v ? 'HD mode enabled' : 'HD mode disabled',
        message: v
          ? 'Original-resolution skins and capes will be served in-game — install OptiFine or CustomSkinLoader to render them in full HD.'
          : 'HD skins and capes are downscaled to 64×64/64×32 so vanilla Minecraft renders them correctly.',
        duration: 4000,
      });
    } catch (e) {
      add({ type: 'error', title: 'Could not change HD mode', message: String(e), duration: 4000 });
    }
  };

  const handleMsLinked = async () => {
    add({ type: 'success', title: 'Microsoft linked', message: 'Your skin is ready to preview.', duration: 3000 });
    await loadMicrosoft();
    void loadProfile();
    void loadMsCustom();
  };

  const chooseVariant = async (variant: 'classic' | 'slim') => {
    if (!offline) return;
    setOffline({ ...offline, variant });
    if (offline.skinData) {
      try {
        await window.slime.skin.set({ base64: offline.skinData, variant });
        add({ type: 'success', title: 'Skin variant updated', message: variant === 'slim' ? 'Slim (Alex) model selected.' : 'Classic (Steve) model selected.', duration: 2500 });
      } catch (e) {
        add({ type: 'error', title: 'Update failed', message: String(e), duration: 4000 });
      }
    }
  };

  const uploadSkin = async () => {
    const path = await window.slime.fs.selectFile([{ name: 'PNG skin (64×64–1024×1024, HD)', extensions: ['png'] }]);
    if (!path) return;
    setUploading(true);
    try {
      const variant = offline?.variant || 'classic';
      const res = await window.slime.skin.set({ path, variant });
      if (res.ok) {
        add({ type: 'success', title: 'Skin applied', message: 'Your skin is now visible to players using SlimeLauncher.', duration: 4000 });
        void loadOffline();
      } else {
        add({ type: 'error', title: 'Skin rejected', message: res.error || 'Unknown error', duration: 5000 });
      }
    } catch (e) {
      add({ type: 'error', title: 'Upload failed', message: String(e), duration: 5000 });
    } finally {
      setUploading(false);
    }
  };

  const removeSkin = async () => {
    try {
      await window.slime.skin.remove();
      add({ type: 'info', title: 'Skin removed', message: 'Your offline skin was reset to default.', duration: 3000 });
      void loadOffline();
    } catch (e) {
      add({ type: 'error', title: 'Remove failed', message: String(e), duration: 4000 });
    }
  };

  const uploadCape = async () => {
    const path = await window.slime.fs.selectFile([{ name: 'PNG cape (64×32–1024×512, HD)', extensions: ['png'] }]);
    if (!path) return;
    setUploadingCape(true);
    try {
      const res = await window.slime.skin.setCape({ path });
      if (res.ok) {
        add({ type: 'success', title: 'Cape applied', message: 'Your cape is now visible to players using SlimeLauncher.', duration: 4000 });
        void loadOffline();
      } else {
        add({ type: 'error', title: 'Cape rejected', message: res.error || 'Unknown error', duration: 5000 });
      }
    } catch (e) {
      add({ type: 'error', title: 'Upload failed', message: String(e), duration: 5000 });
    } finally {
      setUploadingCape(false);
    }
  };

  const removeCape = async () => {
    try {
      await window.slime.skin.removeCape();
      add({ type: 'info', title: 'Cape removed', message: 'Your offline cape was removed.', duration: 3000 });
      void loadOffline();
    } catch (e) {
      add({ type: 'error', title: 'Remove failed', message: String(e), duration: 4000 });
    }
  };

  const uploadMsSkin = async () => {
    const path = await window.slime.fs.selectFile([{ name: 'PNG skin (64×64–1024×1024, HD)', extensions: ['png'] }]);
    if (!path) return;
    setUploadingMsSkin(true);
    try {
      const res = await window.slime.ms.setCustomSkin({ path, variant: msCustom?.variant === 'slim' ? 'slim' : 'classic' });
      if (res.ok) {
        add({ type: 'success', title: 'Skin applied', message: 'Your custom skin will be visible in-game for SlimeLauncher players.', duration: 4000 });
        void loadMsCustom();
      } else {
        add({ type: 'error', title: 'Skin rejected', message: res.error || 'Unknown error', duration: 5000 });
      }
    } catch (e) {
      add({ type: 'error', title: 'Upload failed', message: String(e), duration: 5000 });
    } finally {
      setUploadingMsSkin(false);
    }
  };

  const removeMsSkin = async () => {
    try {
      await window.slime.ms.removeCustomSkin();
      add({ type: 'info', title: 'Skin reset', message: 'Your official Microsoft skin is restored.', duration: 3000 });
      void loadMsCustom();
    } catch (e) {
      add({ type: 'error', title: 'Remove failed', message: String(e), duration: 4000 });
    }
  };

  const uploadMsCape = async () => {
    const path = await window.slime.fs.selectFile([{ name: 'PNG cape (64×32–1024×512, HD)', extensions: ['png'] }]);
    if (!path) return;
    setUploadingMsCape(true);
    try {
      const res = await window.slime.ms.setCustomCape({ path });
      if (res.ok) {
        add({ type: 'success', title: 'Cape applied', message: 'Your custom cape will be visible in-game for SlimeLauncher players.', duration: 4000 });
        void loadMsCustom();
      } else {
        add({ type: 'error', title: 'Cape rejected', message: res.error || 'Unknown error', duration: 5000 });
      }
    } catch (e) {
      add({ type: 'error', title: 'Upload failed', message: String(e), duration: 5000 });
    } finally {
      setUploadingMsCape(false);
    }
  };

  const removeMsCape = async () => {
    try {
      await window.slime.ms.removeCustomCape();
      add({ type: 'info', title: 'Cape removed', message: 'Your official cape is restored.', duration: 3000 });
      void loadMsCustom();
    } catch (e) {
      add({ type: 'error', title: 'Remove failed', message: String(e), duration: 4000 });
    }
  };

  const skin = profile?.skinUrl ? profile.skins.find((s) => s.state === 'ACTIVE') || null : null;
  const cape = profile?.capeUrl ? profile.capes.find((c) => c.state === 'ACTIVE') || null : null;

  // The effective in-game look: a SlimeLauncher custom skin/cape overrides the
  // official Microsoft one. Used by the 3D preview.
  const previewSkin =
    msCustom?.hasSkin && msCustom.skinData
      ? `data:image/png;base64,${msCustom.skinData}`
      : (profile?.skinUrl || null);
  const previewCape =
    msCustom?.hasCape && msCustom.capeData
      ? `data:image/png;base64,${msCustom.capeData}`
      : (cape?.url || null);
  const previewVariant: 'classic' | 'slim' =
    msCustom?.hasSkin && msCustom.skinData
      ? msCustom.variant === 'slim' ? 'slim' : 'classic'
      : (skin?.variant === 'slim' ? 'slim' : 'classic');

  return (
    <div className="skins-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Skins</h1>
          <p className="page-subtitle">
            {user ? `${user.username}'s Minecraft look` : 'Your personal Minecraft style.'}
          </p>
        </div>
        {profile && (
          <Button variant="ghost" size="sm" icon={<RefreshCw size={14} />} onClick={() => void loadProfile()} loading={loading}>
            Refresh
          </Button>
        )}
      </div>

      {/* How skins work — simple guide like TLauncher */}
      <section className="skin-card card skin-help-card" style={{ borderLeft: '3px solid #4ade80' }}>
        <div className="skin-card-head">
          <h3><Sparkles size={16} /> {t('skins.help_title')}</h3>
        </div>
        <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13, lineHeight: 1.5 }}>
          <p style={{ margin: 0, opacity: 0.9 }}>
            <b>{t('skins.help_opt1_title')}</b> {t('skins.help_opt1_text')}
          </p>
          <p style={{ margin: 0, opacity: 0.9 }}>
            <b>{t('skins.help_opt2_title')}</b> {t('skins.help_opt2_before')} <a href="https://ely.by" target="_blank" rel="noreferrer" style={{ color: '#4ade80', textDecoration: 'underline' }}>https://ely.by</a> {t('skins.help_opt2_after')}
          </p>
          <p style={{ margin: 0, opacity: 0.7, fontSize: 12 }}>
            {t('skins.help_hint')}
          </p>
        </div>
      </section>

      {/* Offline skin (SlimeLauncher account) */}
      {user && (
        <section className="skin-card card offline-skin-section">
          <div className="skin-card-head">
            <h3><Shirt size={16} /> Offline skin (SlimeLauncher)</h3>
            <div className="skin-badges">
              <SizeBadge w={offline?.skinWidth ?? null} h={offline?.skinHeight ?? null} vanillaW={64} vanillaH={64} />
              <span className="skin-badge">{offline?.hasSkin ? 'Custom' : 'Default'}</span>
            </div>
          </div>
          <div className="offline-skin-body">
            {offline?.hasSkin && offline.skinData ? (
              <div className="offline-skin-3d">
                <SkinViewer3D
                  skinSrc={`data:image/png;base64,${offline.skinData}`}
                  capeSrc={offline.hasCape && offline.capeData ? `data:image/png;base64,${offline.capeData}` : null}
                  variant={offline.variant === 'slim' ? 'slim' : 'classic'}
                  width={260}
                  height={300}
                />
                <span className="skin-info-label">3D preview — early test version (front / side / back)</span>
              </div>
            ) : (
              <div className="cape-empty offline-skin-empty">
                <Sparkles size={22} />
                <span>No custom skin yet.</span>
              </div>
            )}
            <div className="offline-skin-controls">
              <div className="offline-variant-row">
                <span className="skin-info-label">Model</span>
                <div className="loader-pills">
                  <button className={`loader-pill ${offline?.variant === 'classic' ? 'loader-pill-active' : ''}`} onClick={() => chooseVariant('classic')}>Classic (Steve)</button>
                  <button className={`loader-pill ${offline?.variant === 'slim' ? 'loader-pill-active' : ''}`} onClick={() => chooseVariant('slim')}>Slim (Alex)</button>
                </div>
              </div>
              <div className="offline-skin-actions">
                <Button variant="secondary" size="sm" icon={<Upload size={14} />} loading={uploading} onClick={uploadSkin}>
                  {offline?.hasSkin ? 'Replace skin' : 'Upload skin'}
                </Button>
                {offline?.hasSkin && (
                  <Button variant="ghost" size="sm" icon={<Trash2 size={14} />} onClick={removeSkin}>
                    Remove
                  </Button>
                )}
              </div>
              <p className="skin-hint">
                Upload a PNG skin up to 1024×1024 (square) or 1024×512 (legacy 2:1) — HD is fully supported.
                Your skin is served by SlimeLauncher's local skin server, so it is visible to any player launching Minecraft from this launcher — including friends on the same network.
                In-game it is downscaled to 64×64 for vanilla Minecraft; enable “HD textures in-game” below to serve the original resolution.
              </p>
            </div>
          </div>
          {/* Cape */}
          <div className="offline-cape-row">
            <div className="offline-cape-preview">
              {offline?.hasCape && offline.capeData ? (
                <img className="cape-preview" src={`data:image/png;base64,${offline.capeData}`} alt="Your offline cape" />
              ) : (
                <div className="cape-empty offline-cape-empty">
                  <Gamepad2 size={20} />
                  <span>No cape</span>
                </div>
              )}
            </div>
            <div className="offline-cape-controls">
              <div className="skin-info-label-row">
                <span className="skin-info-label">Cape</span>
                <SizeBadge w={offline?.capeWidth ?? null} h={offline?.capeHeight ?? null} vanillaW={64} vanillaH={32} />
              </div>
              <div className="offline-skin-actions">
                <Button variant="secondary" size="sm" icon={<Upload size={14} />} loading={uploadingCape} onClick={uploadCape}>
                  {offline?.hasCape ? 'Replace cape' : 'Upload cape'}
                </Button>
                {offline?.hasCape && (
                  <Button variant="ghost" size="sm" icon={<Trash2 size={14} />} onClick={removeCape}>
                    Remove
                  </Button>
                )}
              </div>
              <p className="skin-hint">
                Upload a 2:1 PNG cape up to 1024×512 — HD capes are supported. Like the skin, it is only visible to players launching Minecraft from this launcher.
              </p>
            </div>
          </div>
        </section>
      )}

      {/* HD textures in-game — global: decides what the local skin server
          serves to the game launched from this machine. */}
      <section className="skin-card card hd-mode-card">
        <div className="skin-card-head">
          <h3><Sparkles size={16} /> HD textures in-game</h3>
          <Toggle checked={hdMode} onChange={(v) => void toggleHdMode(v)} label="HD textures in-game" />
        </div>
        <p className="skin-hint">
          {hdMode
            ? 'Original-resolution skins and capes are served to the game. Vanilla Minecraft cannot render HD textures — install OptiFine or CustomSkinLoader to see them in full resolution.'
            : 'HD skins and capes are automatically downscaled to 64×64 / 64×32 so vanilla Minecraft renders them correctly (the 3D preview still shows the full HD image). Turn this on if you play with OptiFine or CustomSkinLoader.'}
        </p>
      </section>

      {loading ? (
        <LoadingState label="Fetching your Microsoft skin..." />
      ) : profile && profile.skinUrl ? (
        <div className="skin-preview-grid">
          {/* 3D character preview */}
          <div className="skin-card card skin-viewer-card">
            <div className="skin-card-head">
              <h3><User size={16} /> Character preview (3D)</h3>
              <span className="skin-badge">{previewVariant === 'slim' ? 'Slim (Alex)' : 'Classic (Steve)'}</span>
            </div>
            <SkinViewer3D skinSrc={previewSkin} capeSrc={previewCape} variant={previewVariant} width={280} height={320} />
            <p className="skin-hint">
              Early test version of the 3D preview.{' '}
              {msCustom?.hasSkin || msCustom?.hasCape
                ? 'Your SlimeLauncher custom look (what launcher players see).'
                : 'Your official Minecraft look.'}
            </p>
          </div>

          {/* Skin texture */}
          <div className="skin-card card">
            <div className="skin-card-head">
              <h3><Shirt size={16} /> Microsoft skin texture</h3>
              <span className="skin-badge">{skin?.variant === 'slim' ? 'Slim (Alex)' : 'Classic (Steve)'}</span>
            </div>
            <div className="skin-texture-wrap">
              <img className="skin-texture" src={profile.skinUrl} alt="Skin texture" />
            </div>
            <p className="skin-hint">This is the raw 64×64 texture from your Minecraft profile.</p>
          </div>

          {/* Cape */}
          <div className="skin-card card">
            <div className="skin-card-head">
              <h3><Gamepad2 size={16} /> Cape</h3>
              {cape ? <span className="skin-badge">Active</span> : <span className="skin-badge skin-badge-off">None</span>}
            </div>
            {cape ? (
              <div className="cape-preview-wrap">
                <img className="cape-preview" src={cape.url} alt="Cape" />
              </div>
            ) : (
              <div className="cape-empty">
                <Sparkles size={22} />
                <span>No cape on this account yet.</span>
              </div>
            )}
            <p className="skin-hint">{cape ? 'Your active Minecraft cape.' : 'Capes appear behind your character in-game.'}</p>
          </div>

          {/* Custom look — served by SlimeLauncher's skin server (launcher players only) */}
          <div className="skin-card card skin-info-card">
            <div className="skin-card-head">
              <h3><Sparkles size={16} /> Custom look (SlimeLauncher)</h3>
              {msCustom?.hasSkin || msCustom?.hasCape ? <span className="skin-badge">Custom</span> : <span className="skin-badge skin-badge-off">Official</span>}
            </div>
            <div className="offline-skin-body ms-custom-body">
              <div className="ms-custom-previews">
                {msCustom?.hasSkin && msCustom.skinData ? (
                  <div className="ms-custom-item">
                    <img className="skin-texture" src={`data:image/png;base64,${msCustom.skinData}`} alt="Custom skin" style={{ maxWidth: 90 }} />
                    <SizeBadge w={msCustom.skinWidth} h={msCustom.skinHeight} vanillaW={64} vanillaH={64} />
                  </div>
                ) : (
                  <div className="cape-empty" style={{ minHeight: 40 }}><Sparkles size={16} /><span>Official skin</span></div>
                )}
                {msCustom?.hasCape && msCustom.capeData ? (
                  <div className="ms-custom-item">
                    <img className="cape-preview" src={`data:image/png;base64,${msCustom.capeData}`} alt="Custom cape" style={{ maxWidth: 110 }} />
                    <SizeBadge w={msCustom.capeWidth} h={msCustom.capeHeight} vanillaW={64} vanillaH={32} />
                  </div>
                ) : (
                  <div className="cape-empty" style={{ minHeight: 40 }}><Sparkles size={16} /><span>Official cape</span></div>
                )}
              </div>
              <div className="offline-skin-controls" style={{ gap: 10 }}>
                <div className="offline-skin-actions">
                  <Button variant="secondary" size="sm" icon={<Upload size={14} />} loading={uploadingMsSkin} onClick={uploadMsSkin}>
                    {msCustom?.hasSkin ? 'Replace skin' : 'Upload custom skin'}
                  </Button>
                  {msCustom?.hasSkin && (
                    <Button variant="ghost" size="sm" icon={<Trash2 size={14} />} onClick={removeMsSkin}>
                      Reset to official
                    </Button>
                  )}
                </div>
                <div className="offline-skin-actions">
                  <Button variant="secondary" size="sm" icon={<Upload size={14} />} loading={uploadingMsCape} onClick={uploadMsCape}>
                    {msCustom?.hasCape ? 'Replace cape' : 'Upload custom cape'}
                  </Button>
                  {msCustom?.hasCape && (
                    <Button variant="ghost" size="sm" icon={<Trash2 size={14} />} onClick={removeMsCape}>
                      Reset cape
                    </Button>
                  )}
                </div>
                <p className="skin-hint">
                  Custom skin and cape (up to 1024 px, HD supported) are served by SlimeLauncher's skin server — you and other SlimeLauncher players
                  will see them in-game (on real online servers other players still see your official look).
                  HD files are downscaled to 64×64 / 64×32 for vanilla clients unless “HD textures in-game” is enabled.
                </p>
              </div>
            </div>
          </div>

          {/* Account info */}
          <div className="skin-card card skin-info-card">
            <div className="skin-card-head">
              <h3><Link2 size={16} /> Profile</h3>
            </div>
            <div className="skin-info-row">
              <span className="skin-info-label">Username</span>
              <span className="skin-info-value">{profile.username}</span>
            </div>
            <div className="skin-info-row">
              <span className="skin-info-label">UUID</span>
              <span className="skin-info-value skin-uuid">{profile.uuid}</span>
            </div>
            <div className="skin-info-row">
              <span className="skin-info-label">Skin files</span>
              <span className="skin-info-value">{profile.skins.length}</span>
            </div>
            <div className="skin-info-row">
              <span className="skin-info-label">Capes</span>
              <span className="skin-info-value">{profile.capes.length}</span>
            </div>
          </div>
        </div>
      ) : activeMicrosoft ? (
        <div className="skin-preview-grid">
          <div className="skin-card card skin-info-card">
            <div className="skin-card-head">
              <h3><Link2 size={16} /> Microsoft profile</h3>
              <span className="skin-badge">Linked as {activeMicrosoft.username}</span>
            </div>
            <p className="skin-hint" style={{ marginTop: 8 }}>
              {error
                ? `Could not load the profile: ${error}`
                : 'Your profile is linked. Refresh to load your real skin and cape.'}
            </p>
            <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Button variant="primary" icon={<RefreshCw size={16} />} onClick={() => void loadProfile()} loading={loading}>
                Refresh
              </Button>
              <Button variant="ghost" icon={<Link2 size={16} />} onClick={() => setShowMsModal(true)}>
                Re-link
              </Button>
            </div>
          </div>
        </div>
      ) : !user ? (
        <EmptyState
          title="Sign in to manage your skins"
          description="Sign in with a SlimeLauncher account to upload an offline skin, or link a Microsoft account for your real profile."
          icon={<Shirt size={28} />}
        />
      ) : (
        <div className="skin-preview-grid">
          <div className="skin-card card skin-info-card">
            <div className="skin-card-head">
              <h3><Link2 size={16} /> Microsoft profile</h3>
            </div>
            <p className="skin-hint" style={{ marginTop: 8 }}>
              {error || 'Link your Microsoft Minecraft account to preview your real skin and cape here.'}
            </p>
            <div style={{ marginTop: 12 }}>
              <Button variant="primary" icon={<Link2 size={16} />} onClick={() => setShowMsModal(true)}>
                Link Microsoft Account
              </Button>
            </div>
          </div>
        </div>
      )}

      <MicrosoftLoginModal
        open={showMsModal}
        onClose={() => setShowMsModal(false)}
        onSuccess={() => void handleMsLinked()}
      />
    </div>
  );
}

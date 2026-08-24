import { useState } from 'react';
import { motion } from 'framer-motion';
import {
  Settings as SettingsIcon, Palette, Sparkles, Gamepad2, Download, User, Terminal, Globe, FolderOpen, Link2, Unlink, HardDrive,
} from 'lucide-react';
import { useSettingsStore } from '@/store/settings-store';
import { useAuthStore } from '@/store/auth-store';
import { useNotificationStore } from '@/store/notification-store';
import { useNavigationStore } from '@/store/navigation-store';
import { Toggle } from '@/components/Toggle';
import { Input } from '@/components/Input';
import { Button } from '@/components/Button';
import { t } from '@/lib/i18n';
import './SettingsPage.css';

type SectionId = 'general' | 'appearance' | 'animations' | 'minecraft' | 'downloads' | 'backups' | 'account' | 'advanced';

const SECTIONS: { id: SectionId; labelKey: string; icon: React.ComponentType<{ size?: number | string }> }[] = [
  { id: 'general', labelKey: 'settings.general', icon: SettingsIcon },
  { id: 'appearance', labelKey: 'settings.appearance', icon: Palette },
  { id: 'animations', labelKey: 'settings.animations', icon: Sparkles },
  { id: 'minecraft', labelKey: 'settings.minecraft', icon: Gamepad2 },
  { id: 'downloads', labelKey: 'settings.downloads_section', icon: Download },
  { id: 'backups', labelKey: 'settings.backups_section', icon: HardDrive },
  { id: 'account', labelKey: 'settings.account', icon: User },
  { id: 'advanced', labelKey: 'settings.advanced', icon: Terminal },
];

const ACCENTS = ['#4ade80', '#22c55e', '#60a5fa', '#a78bfa', '#f472b6', '#fbbf24', '#f87171', '#38bdf8'];

export function SettingsPage() {
  const { settings, update, languageKey } = useSettingsStore();
  const { user, logout, microsoftAccounts, loginMicrosoft, logoutMicrosoft, loadMicrosoft } = useAuthStore();
  const { add } = useNotificationStore();
  const { navigate } = useNavigationStore();
  const [section, setSection] = useState<SectionId>('general');
  const [linkingMs, setLinkingMs] = useState(false);

  const handleLinkMs = async () => {
    setLinkingMs(true);
    try {
      const res = await loginMicrosoft();
      if (res.ok) {
        add({ type: 'success', title: 'Microsoft linked', message: 'Your Minecraft account is connected.', duration: 3500 });
      } else {
        add({ type: 'error', title: 'Microsoft login failed', message: res.error || 'Unknown error', duration: 5000 });
      }
    } catch (e) {
      add({ type: 'error', title: 'Microsoft login failed', message: String(e), duration: 5000 });
    } finally {
      setLinkingMs(false);
    }
  };

  const handleUnlinkMs = async (id: string) => {
    await logoutMicrosoft(id);
    add({ type: 'info', title: 'Account unlinked', message: 'Microsoft account removed.', duration: 3000 });
  };

  // Refresh the linked-account list whenever this section becomes visible.
  const showSection = (s: SectionId) => {
    setSection(s);
    if (s === 'account') void loadMicrosoft();
  };

  const set = (patch: Record<string, unknown>) => {
    update(patch as never);
  };

  const pickDirectory = async (key: 'minecraftDirectory' | 'downloadLocation' | 'defaultJavaPath') => {
    const dir = await window.slime.fs.selectDirectory();
    if (dir) set({ [key]: dir });
  };

  const pickJava = async () => {
    const file = await window.slime.fs.selectFile([{ name: 'Java executable', extensions: ['exe'] }]);
    if (file) set({ defaultJavaPath: file });
  };

  const handleLogout = async () => {
    await logout();
    add({ type: 'info', title: 'Logged out', message: 'You have been signed out.', duration: 3000 });
  };

  const resetSettings = async () => {
    if (!confirm('Reset all settings to defaults?')) return;
    // Go through the store's update (not raw IPC) so the zustand state is
    // applied too — otherwise the UI kept showing the old theme/scale until
    // the app was restarted.
    set({
      theme: 'dark', accentColor: '#4ade80', uiScale: 1, animationsEnabled: true,
      animationIntensity: 0.6, reducedMotion: false, pageTransitions: true,
      blur: true, shadows: true, roundedCorners: true, backgroundStyle: 'gradient',
    });
    add({ type: 'success', title: 'Settings reset', message: 'All settings restored to defaults.', duration: 3000 });
  };

  // Force re-render on language change
  const lk = languageKey;

  return (
    <div className="settings-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('settings.title')}</h1>
          <p className="page-subtitle">{t('settings.subtitle')}</p>
        </div>
      </div>

      <div className="settings-layout">
        <div className="settings-nav">
          {SECTIONS.map((s) => {
            const Icon = s.icon;
            return (
              <button
                key={s.id}
                className={`settings-nav-item ${section === s.id ? 'settings-nav-active' : ''}`}
                onClick={() => showSection(s.id)}
              >
                <Icon size={16} />
                <span>{t(s.labelKey)}</span>
              </button>
            );
          })}
        </div>

        <motion.div
          key={section + lk}
          className="settings-content"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
        >
          {section === 'general' && (
            <div className="settings-group">
              <h3 className="settings-group-title">{t('settings.general')}</h3>
              <div className="setting-row">
                <div>
                  <div className="setting-label">{t('settings.language')}</div>
                  <div className="setting-desc">{t('settings.language_desc')}</div>
                </div>
                <select className="select" value={settings.language} onChange={(e) => set({ language: e.target.value })}>
                  <option value="en">English</option>
                  <option value="ru">Русский</option>
                </select>
              </div>
              <div className="setting-row">
                <div>
                  <div className="setting-label">{t('settings.theme')}</div>
                  <div className="setting-desc">{t('settings.theme_desc')}</div>
                </div>
                <div className="theme-pills">
                  {(['dark', 'midnight', 'slime'] as const).map((th) => (
                    <button
                      key={th}
                      className={`theme-pill ${settings.theme === th ? 'theme-pill-active' : ''}`}
                      onClick={() => set({ theme: th })}
                    >
                      {th}
                    </button>
                  ))}
                </div>
              </div>
              <div className="setting-row">
                <div>
                  <div className="setting-label">{t('settings.start_windows')}</div>
                  <div className="setting-desc">{t('settings.start_windows_desc')}</div>
                </div>
                <Toggle checked={settings.startWithWindows} onChange={(v) => set({ startWithWindows: v })} />
              </div>
              <div className="setting-row">
                <div>
                  <div className="setting-label">{t('settings.minimize_tray')}</div>
                  <div className="setting-desc">{t('settings.minimize_tray_desc')}</div>
                </div>
                <Toggle checked={settings.minimizeToTray} onChange={(v) => set({ minimizeToTray: v })} />
              </div>
              <div className="setting-row">
                <div>
                  <div className="setting-label">{t('settings.close_tray')}</div>
                  <div className="setting-desc">{t('settings.close_tray_desc')}</div>
                </div>
                <Toggle checked={settings.closeToTray} onChange={(v) => set({ closeToTray: v })} />
              </div>
            </div>
          )}

          {section === 'appearance' && (
            <div className="settings-group">
              <h3 className="settings-group-title">{t('settings.appearance')}</h3>
              <div className="setting-row">
                <div>
                  <div className="setting-label">{t('settings.accent')}</div>
                  <div className="setting-desc">{t('settings.accent_desc')}</div>
                </div>
                <div className="accent-swatches">
                  {ACCENTS.map((c) => (
                    <button
                      key={c}
                      className={`accent-swatch ${settings.accentColor === c ? 'accent-swatch-active' : ''}`}
                      style={{ background: c }}
                      onClick={() => set({ accentColor: c })}
                    />
                  ))}
                </div>
              </div>
              <div className="setting-row">
                <div>
                  <div className="setting-label">{t('settings.ui_scale')}</div>
                  <div className="setting-desc">{t('settings.ui_scale_desc')}</div>
                </div>
                <select className="select" value={settings.uiScale} onChange={(e) => set({ uiScale: Number(e.target.value) })}>
                  {[0.8, 0.9, 1, 1.1, 1.25, 1.5].map((s) => (
                    <option key={s} value={s}>{Math.round(s * 100)}%</option>
                  ))}
                </select>
              </div>
              <div className="setting-row">
                <div>
                  <div className="setting-label">{t('settings.blur')}</div>
                  <div className="setting-desc">{t('settings.blur_desc')}</div>
                </div>
                <Toggle checked={settings.blur} onChange={(v) => set({ blur: v })} />
              </div>
              <div className="setting-row">
                <div>
                  <div className="setting-label">{t('settings.shadows')}</div>
                  <div className="setting-desc">{t('settings.shadows_desc')}</div>
                </div>
                <Toggle checked={settings.shadows} onChange={(v) => set({ shadows: v })} />
              </div>
              <div className="setting-row">
                <div>
                  <div className="setting-label">{t('settings.rounded')}</div>
                  <div className="setting-desc">{t('settings.rounded_desc')}</div>
                </div>
                <Toggle checked={settings.roundedCorners} onChange={(v) => set({ roundedCorners: v })} />
              </div>
              <div className="setting-row">
                <div>
                  <div className="setting-label">{t('settings.background')}</div>
                  <div className="setting-desc">{t('settings.background_desc')}</div>
                </div>
                <select className="select" value={settings.backgroundStyle} onChange={(e) => set({ backgroundStyle: e.target.value })}>
                  <option value="gradient">Gradient</option>
                  <option value="slime">Slime blobs</option>
                  <option value="particles">Particles</option>
                  <option value="custom">Custom Image/Video</option>
                  <option value="none">None</option>
                </select>
              </div>
              {settings.backgroundStyle === 'custom' && (
                <>
                  <div className="setting-row">
                    <div>
                      <div className="setting-label">Background File</div>
                      <div className="setting-desc">Select an image or video file (PNG, JPG, GIF, MP4, WEBM).</div>
                    </div>
                    <div className="setting-input-group">
                      <Input value={settings.customBackgroundImage || 'None selected'} readOnly />
                      <Button 
                        variant="secondary" 
                        size="sm" 
                        icon={<FolderOpen size={14} />} 
                        onClick={async () => {
                          const file = await window.slime.fs.selectFile([
                            { name: 'Media files', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4', 'webm'] }
                          ]);
                          if (file) set({ customBackgroundImage: file });
                        }}
                      >
                        {t('settings.browse')}
                      </Button>
                    </div>
                  </div>
                  <div className="setting-row">
                    <div>
                      <div className="setting-label">Background Opacity</div>
                      <div className="setting-desc">Adjust how bright the background is.</div>
                    </div>
                    <input
                      type="range"
                      className="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={settings.customBackgroundOpacity ?? 0.5}
                      onChange={(e) => set({ customBackgroundOpacity: Number(e.target.value) })}
                    />
                  </div>
                  <div className="setting-row">
                    <div>
                      <div className="setting-label">Background Blur</div>
                      <div className="setting-desc">Adjust the blur intensity.</div>
                    </div>
                    <input
                      type="range"
                      className="range"
                      min={0}
                      max={40}
                      step={1}
                      value={settings.customBackgroundBlur ?? 10}
                      onChange={(e) => set({ customBackgroundBlur: Number(e.target.value) })}
                    />
                  </div>
                </>
              )}
            </div>
          )}

          {section === 'animations' && (
            <div className="settings-group">
              <h3 className="settings-group-title">{t('settings.animations')}</h3>
              <div className="setting-row">
                <div>
                  <div className="setting-label">{t('settings.animations_enable')}</div>
                  <div className="setting-desc">{t('settings.animations_enable_desc')}</div>
                </div>
                <Toggle checked={settings.animationsEnabled} onChange={(v) => set({ animationsEnabled: v })} />
              </div>
              <div className="setting-row">
                <div>
                  <div className="setting-label">{t('settings.animation_intensity')}</div>
                  <div className="setting-desc">{t('settings.animation_intensity_desc')}</div>
                </div>
                <input
                  type="range"
                  className="range"
                  min={0}
                  max={1}
                  step={0.1}
                  value={settings.animationIntensity}
                  onChange={(e) => set({ animationIntensity: Number(e.target.value) })}
                />
              </div>
              <div className="setting-row">
                <div>
                  <div className="setting-label">{t('settings.reduced_motion')}</div>
                  <div className="setting-desc">{t('settings.reduced_motion_desc')}</div>
                </div>
                <Toggle checked={settings.reducedMotion} onChange={(v) => set({ reducedMotion: v })} />
              </div>
              <div className="setting-row">
                <div>
                  <div className="setting-label">{t('settings.page_transitions')}</div>
                  <div className="setting-desc">{t('settings.page_transitions_desc')}</div>
                </div>
                <Toggle checked={settings.pageTransitions} onChange={(v) => set({ pageTransitions: v })} />
              </div>
            </div>
          )}

          {section === 'minecraft' && (
            <div className="settings-group">
              <h3 className="settings-group-title">{t('settings.minecraft')}</h3>
              <div className="setting-row">
                <div>
                  <div className="setting-label">{t('settings.mc_dir')}</div>
                  <div className="setting-desc">{t('settings.mc_dir_desc')}</div>
                </div>
                <div className="setting-input-group">
                  <Input value={settings.minecraftDirectory} readOnly />
                  <Button variant="secondary" size="sm" icon={<FolderOpen size={14} />} onClick={() => pickDirectory('minecraftDirectory')}>
                    {t('settings.browse')}
                  </Button>
                </div>
              </div>
              <div className="setting-row">
                <div>
                  <div className="setting-label">{t('settings.java')}</div>
                  <div className="setting-desc">{t('settings.java_desc')}</div>
                </div>
                <div className="setting-input-group">
                  <Input value={settings.defaultJavaPath || 'Auto-detect'} readOnly />
                  <Button variant="secondary" size="sm" icon={<FolderOpen size={14} />} onClick={pickJava}>
                    {t('settings.browse')}
                  </Button>
                </div>
              </div>
              <div className="setting-row">
                <div>
                  <div className="setting-label">{t('settings.ram')}</div>
                  <div className="setting-desc">{t('settings.ram_desc')}</div>
                </div>
                <Input
                  type="number"
                  className="setting-input"
                  value={settings.defaultRamMB}
                  onChange={(e) => set({ defaultRamMB: Number(e.target.value) || 0 })}
                />
              </div>
              <div className="setting-row">
                <div>
                  <div className="setting-label">{t('settings.jvm_args')}</div>
                  <div className="setting-desc">{t('settings.jvm_args_desc')}</div>
                </div>
                <Input
                  className="setting-input"
                  value={settings.jvmArguments}
                  onChange={(e) => set({ jvmArguments: e.target.value })}
                />
              </div>
              <div className="setting-row">
                <div>
                  <div className="setting-label">{t('settings.show_console')}</div>
                  <div className="setting-desc">{t('settings.show_console_desc')}</div>
                </div>
                <Toggle checked={settings.showGameConsole} onChange={(v) => set({ showGameConsole: v })} />
              </div>
              <div className="setting-row">
                <div>
                  <div className="setting-label">{t('settings.discord_enable')}</div>
                  <div className="setting-desc">{t('settings.discord_enable_desc')}</div>
                </div>
                <Toggle checked={!!(settings as unknown as { discordPresenceEnabled?: boolean }).discordPresenceEnabled} onChange={(v) => set({ discordPresenceEnabled: v })} />
              </div>
              {!!(settings as unknown as { discordPresenceEnabled?: boolean }).discordPresenceEnabled && (
                <div className="setting-row">
                  <div>
                    <div className="setting-label">{t('settings.discord_client_id')}</div>
                    <div className="setting-desc">{t('settings.discord_client_id_desc')}</div>
                    <div className="setting-input-group" style={{ marginTop: 8 }}>
                      <Input
                        className="setting-input"
                        placeholder="1234567890123456789"
                        value={(settings as unknown as { discordClientId?: string }).discordClientId || ''}
                        onChange={(e) => set({ discordClientId: e.target.value.trim() })}
                      />
                    </div>
                    <p className="setting-desc" style={{ marginTop: 6, opacity: 0.8 }}>{t('settings.discord_client_id_hint')}</p>
                  </div>
                </div>
              )}
            </div>
          )}

          {section === 'downloads' && (
            <div className="settings-group">
              <h3 className="settings-group-title">{t('settings.downloads_section')}</h3>
              <div className="setting-row">
                <div>
                  <div className="setting-label">{t('settings.dl_threads')}</div>
                  <div className="setting-desc">{t('settings.dl_threads_desc')}</div>
                </div>
                <Input
                  type="number"
                  className="setting-input"
                  value={settings.downloadThreads}
                  onChange={(e) => set({ downloadThreads: Number(e.target.value) || 1 })}
                />
              </div>
              <div className="setting-row">
                <div>
                  <div className="setting-label">{t('settings.dl_location')}</div>
                  <div className="setting-desc">{t('settings.dl_location_desc')}</div>
                </div>
                <div className="setting-input-group">
                  <Input value={settings.downloadLocation} readOnly />
                  <Button variant="secondary" size="sm" icon={<FolderOpen size={14} />} onClick={() => pickDirectory('downloadLocation')}>
                    {t('settings.browse')}
                  </Button>
                </div>
              </div>
              <div className="setting-row">
                <div>
                  <div className="setting-label">{t('settings.auto_update_mods')}</div>
                  <div className="setting-desc">{t('settings.auto_update_mods_desc')}</div>
                </div>
                <Toggle checked={settings.autoUpdateMods} onChange={(v) => set({ autoUpdateMods: v })} />
              </div>
              <div className="setting-row">
                <div>
                  <div className="setting-label">{t('settings.auto_update_launcher')}</div>
                  <div className="setting-desc">{t('settings.auto_update_launcher_desc')}</div>
                </div>
                <Toggle checked={settings.autoUpdateLauncher} onChange={(v) => set({ autoUpdateLauncher: v })} />
              </div>
            </div>
          )}

          {section === 'backups' && (
            <div className="settings-group">
              <h3 className="settings-group-title">{t('settings.backups_section')}</h3>
              <div className="setting-row">
                <div>
                  <div className="setting-label">{t('settings.backups_enable')}</div>
                  <div className="setting-desc">{t('settings.backups_enable_desc')}</div>
                </div>
                <Toggle checked={settings.worldBackupsEnabled} onChange={(v) => set({ worldBackupsEnabled: v })} />
              </div>
              <div className="setting-row">
                <div>
                  <div className="setting-label">{t('settings.backups_keep')}</div>
                  <div className="setting-desc">{t('settings.backups_keep_desc')}</div>
                </div>
                <Input
                  type="number"
                  className="setting-input"
                  value={settings.worldBackupsKeep}
                  onChange={(e) => set({ worldBackupsKeep: Math.max(1, Number(e.target.value) || 1) })}
                />
              </div>
              <div className="setting-row">
                <div>
                  <div className="setting-label">{t('settings.backups_folder')}</div>
                  <div className="setting-desc">{t('settings.backups_folder_desc')}</div>
                </div>
                <div className="setting-input-group">
                  <Input value={settings.worldBackupsFolder || ''} readOnly placeholder="(default)" />
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<FolderOpen size={14} />}
                    onClick={async () => {
                      const dir = await window.slime.fs.selectDirectory();
                      if (dir) set({ worldBackupsFolder: dir });
                    }}
                  >
                    {t('settings.browse')}
                  </Button>
                </div>
              </div>
              <div className="setting-row">
                <div>
                  <div className="setting-label">{t('settings.backups_open')}</div>
                  <div className="setting-desc">{t('settings.backups_open_desc')}</div>
                </div>
                <Button variant="secondary" size="sm" icon={<FolderOpen size={14} />} onClick={() => void window.slime.worldBackups.openFolder()}>
                  {t('settings.open')}
                </Button>
              </div>
            </div>
          )}

          {section === 'account' && (
            <div className="settings-group">
              <h3 className="settings-group-title">{t('settings.account')}</h3>
              {user ? (
                <>
                  <div className="account-summary">
                    <div className="account-avatar">
                      {user.avatar ? <img src={user.avatar} alt="" /> : <User size={28} />}
                    </div>
                    <div>
                      <div className="setting-label" style={{ fontSize: 16, fontWeight: 700 }}>{user.username}</div>
                      <div className="setting-desc">{user.email}</div>
                      <div className="setting-desc">Member since {new Date(user.createdAt).toLocaleDateString()}</div>
                    </div>
                  </div>
                  <div className="setting-row">
                    <div>
                      <div className="setting-label">{t('settings.linked_ms')}</div>
                      <div className="setting-desc">{t('settings.linked_ms_desc')}</div>
                    </div>
                    <Button variant="secondary" size="sm" icon={<Link2 size={14} />} loading={linkingMs} onClick={() => void handleLinkMs()}>
                      {t('settings.link_ms')}
                    </Button>
                  </div>
                  <div className="ms-accounts-list">
                    {microsoftAccounts.length === 0 ? (
                      <div className="setting-desc">No Microsoft accounts linked yet.</div>
                    ) : (
                      microsoftAccounts.map((acc) => (
                        <div className="ms-account-item" key={acc.id}>
                          <div className="ms-account-avatar"><Gamepad2 size={16} /></div>
                          <div className="ms-account-info">
                            <div className="setting-label" style={{ fontSize: 13, fontWeight: 700 }}>{acc.username}</div>
                            <div className="setting-desc">{acc.uuid}</div>
                          </div>
                          <Button variant="ghost" size="sm" icon={<Unlink size={13} />} onClick={() => void handleUnlinkMs(acc.id)}>
                            Unlink
                          </Button>
                        </div>
                      ))
                    )}
                  </div>
                  <div className="setting-row">
                    <div>
                      <div className="setting-label">{t('settings.logout')}</div>
                      <div className="setting-desc">{t('settings.logout_desc')}</div>
                    </div>
                    <Button variant="danger" size="sm" onClick={handleLogout}>
                      {t('settings.logout_btn')}
                    </Button>
                  </div>
                </>
              ) : (
                <div className="setting-desc">{t('settings.not_signed_in')} <a href="#" onClick={(e) => { e.preventDefault(); navigate('login'); }}>{t('settings.sign_in')}</a> {t('settings.sign_in_desc')}</div>
              )}
            </div>
          )}

          {section === 'advanced' && (
            <div className="settings-group">
              <h3 className="settings-group-title">{t('settings.advanced')}</h3>
              <div className="setting-row">
                <div>
                  <div className="setting-label">{t('settings.dev_mode')}</div>
                  <div className="setting-desc">{t('settings.dev_mode_desc')}</div>
                </div>
                <Toggle checked={settings.developerMode} onChange={(v) => set({ developerMode: v })} />
              </div>
              <div className="setting-row">
                <div>
                  <div className="setting-label">{t('settings.ms_client_id')}</div>
                  <div className="setting-desc">{t('settings.ms_client_id_desc')}</div>
                </div>
                <Input
                  className="setting-input"
                  placeholder="c36a9fb6-…"
                  value={settings.msClientId}
                  onChange={(e) => set({ msClientId: e.target.value.trim() })}
                />
              </div>
              <div className="setting-row">
                <div>
                  <div className="setting-label">{t('settings.skin_directory')}</div>
                  <div className="setting-desc">
                    {t('settings.skin_directory_desc')}<br />
                    <b>{t('settings.skin_directory_where')}:</b>{' '}
                    {t('settings.skin_directory_hint', {
                      cmd: 'node server/server.mjs',
                      lan: 'http://192.168.1.X:8080',
                      server: 'server/',
                      example: 'https://xxx.onrender.com',
                    })}
                    <br />
                    <span style={{ opacity: 0.7 }}>{t('settings.skin_directory_details', { guide: 'SKIN_CATALOG_GUIDE.md', readme: 'server/README.md' })}</span>
                  </div>
                </div>
                <Input
                  className="setting-input"
                  placeholder="https://skins.example.com"
                  value={settings.skinDirectoryUrl || ''}
                  onChange={(e) => set({ skinDirectoryUrl: e.target.value.trim() })}
                />
              </div>
              <div className="setting-row">
                <div>
                  <div className="setting-label">{t('settings.open_logs')}</div>
                  <div className="setting-desc">{t('settings.open_logs_desc')}</div>
                </div>
                <Button variant="secondary" size="sm" icon={<Globe size={14} />} onClick={() => window.slime.app.openLogs()}>
                  {t('settings.open')}
                </Button>
              </div>
              <div className="setting-row">
                <div>
                  <div className="setting-label">{t('settings.reset')}</div>
                  <div className="setting-desc">{t('settings.reset_desc')}</div>
                </div>
                <Button variant="danger" size="sm" onClick={resetSettings}>
                  {t('settings.reset')}
                </Button>
              </div>
            </div>
          )}
        </motion.div>
      </div>
    </div>
  );
}
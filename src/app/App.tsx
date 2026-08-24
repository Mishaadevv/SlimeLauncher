import { useEffect, useMemo } from 'react';
import { motion } from 'framer-motion';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Sidebar } from '@/components/Sidebar';
import { Background } from '@/components/Background';
import { Notifications } from '@/components/Notifications';
import { useNavigationStore } from '@/store/navigation-store';
import { useSettingsStore } from '@/store/settings-store';
import { useAuthStore } from '@/store/auth-store';
import { useInstanceStore } from '@/store/instance-store';
import { useDownloadStore } from '@/store/download-store';
import { useNotificationStore } from '@/store/notification-store';
import { setLanguage } from '@/lib/i18n';
import { HomePage } from '@/pages/HomePage';
import { InstancesPage } from '@/pages/InstancesPage';
import { ModpacksPage } from '@/pages/ModpacksPage';
import { ModsPage } from '@/pages/ModsPage';
import { MapsPage } from '@/pages/MapsPage';
import { FriendsPage } from '@/pages/FriendsPage';
import { SkinsPage } from '@/pages/SkinsPage';
import { VersionsPage } from '@/pages/VersionsPage';
import { RecordingsPage } from '@/pages/RecordingsPage';
import { DownloadsPage } from '@/pages/DownloadsPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { AccountPage } from '@/pages/AccountPage';
import { LoginPage } from '@/pages/LoginPage';
import { RegisterPage } from '@/pages/RegisterPage';
import { NetworkPage } from '@/pages/NetworkPage';
import { AccountsPage } from '@/pages/AccountsPage';
import './App.css';

const PAGES: Record<string, React.ComponentType> = {
  home: HomePage,
  instances: InstancesPage,
  modpacks: ModpacksPage,
  mods: ModsPage,
  maps: MapsPage,
  friends: FriendsPage,
  skins: SkinsPage,
  versions: VersionsPage,
  recordings: RecordingsPage,
  downloads: DownloadsPage,
  network: NetworkPage,
  accounts: AccountsPage,
  settings: SettingsPage,
  account: AccountPage,
  login: LoginPage,
  register: RegisterPage,
};

export function App() {
  const { page } = useNavigationStore();
  const { settings, load: loadSettings, languageKey } = useSettingsStore();
  const { loadCurrent } = useAuthStore();
  const { load: loadInstances } = useInstanceStore();
  const { load: loadDownloads } = useDownloadStore();
  const { pushFromMain } = useNotificationStore();

  useEffect(() => {
    loadSettings().then(() => {
      loadCurrent();
      loadInstances();
      loadDownloads();
    });
  }, [loadSettings, loadCurrent, loadInstances, loadDownloads]);

  // Apply language from settings
  useEffect(() => {
    if (settings.language) {
      setLanguage(settings.language);
    }
  }, [settings.language, languageKey]);

  // Listen for main-process notifications
  useEffect(() => {
    if (!window.slime?.notify) return;
    const unsub = window.slime.notify.on((n) => pushFromMain(n as never));
    return () => { unsub?.(); };
  }, [pushFromMain]);

  // Listen for download progress
  useEffect(() => {
    if (!window.slime?.dl) return;
    const unsub = window.slime.dl.onProgress((tasks) => {
      useDownloadStore.setState({ tasks: tasks as never });
    });
    return () => { unsub?.(); };
  }, []);

  // Apply theme + animation + UI scale settings to the DOM
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', settings.theme);
    document.documentElement.setAttribute('data-reduced-motion', String(settings.reducedMotion));
    document.documentElement.setAttribute('data-animations', String(settings.animationsEnabled));
    document.documentElement.style.setProperty('--accent', settings.accentColor);
    document.documentElement.style.setProperty('--accent-2', settings.accentColor);
    document.documentElement.style.setProperty('--accent-glow', `${settings.accentColor}59`);
    document.documentElement.style.setProperty('--accent-soft', `${settings.accentColor}1f`);
    document.documentElement.style.setProperty('--accent-dim', `${settings.accentColor}0f`);
    // UI scale: use CSS zoom on the app container
    document.documentElement.style.fontSize = `${14 * settings.uiScale}px`;
  }, [settings, languageKey]);

  const Page = PAGES[page] || HomePage;
  const anim = settings.animationsEnabled && !settings.reducedMotion && settings.pageTransitions;

  const appStyle = useMemo(() => ({
    transform: settings.uiScale !== 1 ? `scale(${settings.uiScale})` : undefined,
    transformOrigin: 'top left' as const,
    width: settings.uiScale !== 1 ? `${100 / settings.uiScale}%` : undefined,
    height: settings.uiScale !== 1 ? `${100 / settings.uiScale}%` : undefined,
  }), [settings.uiScale]);

  return (
    <div className="app" style={appStyle}>
      <Background />
      <div className="app-body">
        <Sidebar />
        <main className="app-main">
          {/* Keyed mount without AnimatePresence mode="wait": a stuck exit
              animation previously left the content area blank while the
              sidebar stayed visible. Pages now swap immediately and only
              animate in, so navigation can never hang the UI. */}
          <motion.div
            key={page}
            className="page-container"
            initial={anim ? { opacity: 0, y: 12, scale: 0.995 } : false}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            <ErrorBoundary>
              <Page />
            </ErrorBoundary>
          </motion.div>
        </main>
      </div>
      <Notifications />
    </div>
  );
}
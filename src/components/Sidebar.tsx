import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Home, Boxes, Puzzle, Map, Users, Shirt, Layers, Download, Settings, User, Video, Globe,
  ChevronLeft, ChevronRight, Minus, Square, X, Copy, UserRound,
} from 'lucide-react';
import { useNavigationStore, type PageId } from '@/store/navigation-store';
import { useAuthStore } from '@/store/auth-store';
import { useSettingsStore } from '@/store/settings-store';
import { Tooltip } from './Tooltip';
import { AppIcon } from './AppIcon';
import { MsAccountAvatar } from './MsAccountAvatar';
import './Sidebar.css';

import { Package } from 'lucide-react';

const NAV_ITEMS: { id: PageId; label: string; icon: React.ComponentType<{ size?: number | string }> }[] = [
  { id: 'home', label: 'Home', icon: Home },
  { id: 'instances', label: 'Instances', icon: Boxes },
  { id: 'modpacks', label: 'Modpacks', icon: Package },
  { id: 'mods', label: 'Mods', icon: Puzzle },
  { id: 'maps', label: 'Maps', icon: Map },
  { id: 'skins', label: 'Skins', icon: Shirt },
  { id: 'versions', label: 'Versions', icon: Layers },
  { id: 'network', label: 'Network', icon: Globe },
  { id: 'friends', label: 'Friends', icon: Users },
  { id: 'recordings', label: 'Recordings', icon: Video },
  { id: 'downloads', label: 'Downloads', icon: Download },
  { id: 'accounts', label: 'Accounts', icon: UserRound },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export function Sidebar() {
  const { page, navigate, sidebarCollapsed, toggleSidebar } = useNavigationStore();
  const { user, activeMicrosoft } = useAuthStore();
  const { settings } = useSettingsStore();
  const anim = settings.animationsEnabled && !settings.reducedMotion;
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    window.slime.app.isMaximized().then(setMaximized);
    const unsub = window.slime.app.onMaximizeChange(setMaximized);
    return () => { unsub(); };
  }, []);

  return (
    <motion.aside
      className={`sidebar ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}
      animate={{ width: sidebarCollapsed ? 72 : 240 }}
      transition={anim ? { duration: 0.25, ease: [0.22, 1, 0.36, 1] } : undefined}
    >
      <div className="sidebar-logo">
        <AppIcon size={32} />
        {!sidebarCollapsed && (
          <motion.span
            className="sidebar-logo-text"
            initial={anim ? { opacity: 0 } : false}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.1 }}
          >
            Slime<span className="accent">Launcher</span>
          </motion.span>
        )}
      </div>

      <nav className="sidebar-nav">
        {NAV_ITEMS.map((item) => {
          const active = page === item.id;
          const Icon = item.icon;
          return (
            <Tooltip key={item.id} label={item.label} side="right" delay={400}>
              <button
                className={`sidebar-item ${active ? 'sidebar-item-active' : ''}`}
                onClick={() => navigate(item.id)}
              >
                {active && (
                  <motion.span
                    className="sidebar-indicator"
                    layoutId="sidebar-indicator"
                    transition={anim ? { type: 'spring', stiffness: 400, damping: 32 } : undefined}
                  />
                )}
                <span className="sidebar-item-icon">
                  <Icon size={20} />
                </span>
                {!sidebarCollapsed && (
                  <span className="sidebar-item-label">{item.label}</span>
                )}
              </button>
            </Tooltip>
          );
        })}
      </nav>

      <div className="sidebar-bottom">
        <Tooltip label={user || activeMicrosoft ? 'Account' : 'Sign in'} side="right" delay={400}>
          <button
            className={`sidebar-item ${page === 'account' || page === 'login' || page === 'register' ? 'sidebar-item-active' : ''}`}
            onClick={() => navigate(user || activeMicrosoft ? 'account' : 'login')}
          >
            {page === 'account' && (
              <motion.span
                className="sidebar-indicator"
                layoutId="sidebar-indicator"
                transition={anim ? { type: 'spring', stiffness: 400, damping: 32 } : undefined}
              />
            )}
            <span className="sidebar-item-icon">
              {activeMicrosoft ? (
                <MsAccountAvatar active size={22} />
              ) : user?.avatar ? (
                <img src={user.avatar} alt="" className="sidebar-avatar" />
              ) : (
                <User size={20} />
              )}
            </span>
            {!sidebarCollapsed && (
              <span className="sidebar-item-label">
                {activeMicrosoft?.username || (user ? user.username : 'Sign in')}
              </span>
            )}
          </button>
        </Tooltip>

        <div className="sidebar-window-controls">
          <button className="sidebar-win-btn" onClick={() => window.slime.app.minimize()} aria-label="Minimize">
            <Minus size={14} />
          </button>
          <button className="sidebar-win-btn" onClick={() => window.slime.app.maximize()} aria-label="Maximize">
            {maximized ? <Copy size={11} /> : <Square size={11} />}
          </button>
          <button className="sidebar-win-btn sidebar-win-close" onClick={() => window.slime.app.close()} aria-label="Close">
            <X size={14} />
          </button>
        </div>

        <button className="sidebar-collapse-btn" onClick={toggleSidebar}>
          {sidebarCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
        </button>
      </div>
    </motion.aside>
  );
}
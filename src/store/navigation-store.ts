import { create } from 'zustand';

export type PageId =
  | 'home'
  | 'instances'
  | 'modpacks'
  | 'mods'
  | 'maps'
  | 'network'
  | 'friends'
  | 'skins'
  | 'versions'
  | 'recordings'
  | 'downloads'
  | 'accounts'
  | 'settings'
  | 'account'
  | 'login'
  | 'register';

interface NavigationState {
  page: PageId;
  sidebarCollapsed: boolean;
  navigate: (page: PageId) => void;
  toggleSidebar: () => void;
  setSidebarCollapsed: (v: boolean) => void;
}

export const useNavigationStore = create<NavigationState>((set) => ({
  page: 'home',
  sidebarCollapsed: false,
  navigate: (page) => set({ page }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),
}));
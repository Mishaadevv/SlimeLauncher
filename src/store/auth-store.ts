import { create } from 'zustand';
import type { UserAccount, MicrosoftAccount } from '@shared/types';

interface AuthState {
  user: UserAccount | null;
  microsoftAccounts: MicrosoftAccount[];
  activeMicrosoft: MicrosoftAccount | null;
  loading: boolean;
  error: string | null;
  loadCurrent: () => Promise<void>;
  register: (username: string, email: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  login: (email: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  logout: () => Promise<void>;
  updateProfile: (patch: { username?: string; avatar?: string | null }) => Promise<{ ok: boolean; error?: string }>;
  changePassword: (current: string, next: string) => Promise<{ ok: boolean; error?: string }>;
  loadMicrosoft: () => Promise<void>;
  loginMicrosoft: () => Promise<{ ok: boolean; error?: string }>;
  logoutMicrosoft: (id: string) => Promise<void>;
  setActiveMicrosoft: (id: string) => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  microsoftAccounts: [],
  activeMicrosoft: null,
  loading: false,
  error: null,

  loadCurrent: async () => {
    if (!window.slime?.auth) return;
    try {
      const user = await window.slime.auth.current();
      set({ user });
      await get().loadMicrosoft();
    } catch { /* ignore */ }
  },

  register: async (username, email, password) => {
    set({ loading: true, error: null });
    try {
      const res = await window.slime.auth.register(username, email, password);
      if (res.ok && res.user) { set({ user: res.user }); return { ok: true }; }
      set({ error: res.error || 'Registration failed' });
      return { ok: false, error: res.error };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      set({ error: error || 'Registration failed' });
      return { ok: false, error };
    } finally {
      set({ loading: false });
    }
  },

  login: async (email, password) => {
    set({ loading: true, error: null });
    try {
      const res = await window.slime.auth.login(email, password);
      if (res.ok && res.user) { set({ user: res.user }); return { ok: true }; }
      set({ error: res.error || 'Login failed' });
      return { ok: false, error: res.error };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      set({ error: error || 'Login failed' });
      return { ok: false, error };
    } finally {
      set({ loading: false });
    }
  },

  logout: async () => {
    await window.slime.auth.logout();
    set({ user: null });
  },

  updateProfile: async (patch) => {
    const res = await window.slime.auth.updateProfile(patch);
    if (res.ok && res.user) { set({ user: res.user }); return { ok: true }; }
    return { ok: false, error: res.error };
  },

  changePassword: async (current, next) => {
    const res = await window.slime.auth.changePassword(current, next);
    return { ok: res.ok, error: res.error };
  },

  loadMicrosoft: async () => {
    if (!window.slime?.ms) return;
    try {
      const accounts = await window.slime.ms.list();
      const active = accounts?.[0] || null;
      set({ microsoftAccounts: accounts || [], activeMicrosoft: active });
    } catch { /* ignore */ }
  },

  loginMicrosoft: async () => {
    const res = await window.slime.ms.login();
    if (res.ok) { await get().loadMicrosoft(); return { ok: true }; }
    return { ok: false, error: res.error };
  },

  logoutMicrosoft: async (id) => {
    await window.slime.ms.logout(id);
    await get().loadMicrosoft();
  },

  setActiveMicrosoft: async (id) => {
    await window.slime.ms.setActive(id);
    await get().loadMicrosoft();
  },
}));

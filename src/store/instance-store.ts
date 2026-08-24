import { create } from 'zustand';
import type { MinecraftInstance, LoaderType } from '@shared/types';
import { useNotificationStore } from './notification-store';

// Shows an error toast and returns a short message. Keeps the stores free of
// silent failures: every IPC error below surfaces to the user.
function notifyError(action: string, e: unknown): string {
  const error = e instanceof Error ? e.message : String(e);
  useNotificationStore.getState().add({
    type: 'error',
    title: action,
    message: error || 'Unknown error',
    duration: 6000,
  });
  return error;
}

interface InstanceState {
  instances: MinecraftInstance[];
  selectedId: string | null;
  loading: boolean;
  load: () => Promise<void>;
  create: (data: Partial<MinecraftInstance>) => Promise<MinecraftInstance | null>;
  update: (id: string, patch: Partial<MinecraftInstance>) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
  duplicate: (id: string) => Promise<boolean>;
  select: (id: string | null) => void;
  getSelected: () => MinecraftInstance | null;
}

export const useInstanceStore = create<InstanceState>((set, get) => ({
  instances: [],
  selectedId: null,
  loading: false,

  load: async () => {
    if (!window.slime?.instance) return;
    set({ loading: true });
    try {
      const instances = (await window.slime.instance.list()) || [];
      const selectedId = get().selectedId && instances.some((i: MinecraftInstance) => i.id === get().selectedId)
        ? get().selectedId
        : instances[0]?.id || null;
      set({ instances, selectedId, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  create: async (data) => {
    try {
      const inst = await window.slime.instance.create(data);
      if (!inst || !inst.id) throw new Error('Instance was not created');
      await get().load();
      set({ selectedId: inst.id });
      return inst;
    } catch (e) {
      notifyError('Failed to create instance', e);
      return null;
    }
  },

  update: async (id, patch) => {
    try {
      await window.slime.instance.update(id, patch);
    } catch (e) {
      notifyError('Failed to update instance', e);
      return false;
    }
    await get().load();
    return true;
  },

  remove: async (id) => {
    try {
      await window.slime.instance.delete(id);
      if (get().selectedId === id) set({ selectedId: null });
    } catch (e) {
      notifyError('Failed to delete instance', e);
      return false;
    }
    await get().load();
    return true;
  },

  duplicate: async (id) => {
    try {
      await window.slime.instance.duplicate(id);
    } catch (e) {
      notifyError('Failed to duplicate instance', e);
      return false;
    }
    await get().load();
    return true;
  },

  select: (id) => set({ selectedId: id }),

  getSelected: () => {
    const { instances, selectedId } = get();
    return instances.find((i: MinecraftInstance) => i.id === selectedId) || null;
  },
}));

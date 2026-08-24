import { create } from 'zustand';
import type { DownloadTask } from '@shared/types';

interface DownloadState {
  tasks: DownloadTask[];
  load: () => Promise<void>;
  pause: (id: string) => Promise<void>;
  resume: (id: string) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  retry: (id: string) => Promise<void>;
  clearCompleted: () => Promise<void>;
  setTasks: (tasks: DownloadTask[]) => void;
}

export const useDownloadStore = create<DownloadState>((set, get) => ({
  tasks: [],
  load: async () => {
    if (!window.slime?.dl) return;
    try {
      const tasks = (await window.slime.dl.list()) || [];
      set({ tasks });
    } catch { /* ignore */ }
  },
  pause: async (id) => { await window.slime.dl.pause(id); },
  resume: async (id) => { await window.slime.dl.resume(id); },
  cancel: async (id) => { await window.slime.dl.cancel(id); },
  retry: async (id) => { await window.slime.dl.retry(id); },
  clearCompleted: async () => {
    await window.slime.dl.clearCompleted();
    await get().load();
  },
  setTasks: (tasks) => set({ tasks }),
}));

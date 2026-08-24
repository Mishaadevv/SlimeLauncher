import { create } from 'zustand';
import type { NotificationItem } from '@shared/types';

interface NotificationState {
  notifications: NotificationItem[];
  add: (n: Omit<NotificationItem, 'id' | 'createdAt'>) => void;
  remove: (id: string) => void;
  pushFromMain: (n: NotificationItem) => void;
}

export const useNotificationStore = create<NotificationState>((set) => ({
  notifications: [],
  add: (n) => {
    const item: NotificationItem = {
      ...n,
      id: Math.random().toString(36).slice(2),
      createdAt: Date.now(),
    };
    set((s) => ({ notifications: [...s.notifications, item] }));
    if (n.duration > 0) {
      setTimeout(() => {
        set((s) => ({ notifications: s.notifications.filter((x) => x.id !== item.id) }));
      }, n.duration);
    }
  },
  remove: (id) => set((s) => ({ notifications: s.notifications.filter((n) => n.id !== id) })),
  pushFromMain: (n) => {
    set((s) => ({ notifications: [...s.notifications, n] }));
    if (n.duration > 0) {
      setTimeout(() => {
        set((s) => ({ notifications: s.notifications.filter((x) => x.id !== n.id) }));
      }, n.duration);
    }
  },
}));

import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle2, XCircle, Info, AlertTriangle, X } from 'lucide-react';
import { useNotificationStore } from '@/store/notification-store';
import { useSettingsStore } from '@/store/settings-store';
import './Notifications.css';

const ICONS = {
  success: CheckCircle2,
  error: XCircle,
  info: Info,
  warning: AlertTriangle,
};

export function Notifications() {
  const { notifications, remove } = useNotificationStore();
  const { settings } = useSettingsStore();
  const anim = settings.animationsEnabled && !settings.reducedMotion;

  return (
    <div className="notifications">
      <AnimatePresence>
        {notifications.map((n) => {
          const Icon = ICONS[n.type];
          return (
            <motion.div
              key={n.id}
              className={`notification notification-${n.type}`}
              initial={anim ? { opacity: 0, x: 60, scale: 0.95 } : false}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={anim ? { opacity: 0, x: 60, scale: 0.95 } : undefined}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
              layout
            >
              <div className="notification-icon">
                <Icon size={18} />
              </div>
              <div className="notification-body">
                <div className="notification-title">{n.title}</div>
                {n.message && <div className="notification-message">{n.message}</div>}
              </div>
              <button className="notification-close" onClick={() => remove(n.id)}>
                <X size={14} />
              </button>
              {anim && n.duration > 0 && (
                <motion.div
                  className="notification-progress"
                  initial={{ scaleX: 1 }}
                  animate={{ scaleX: 0 }}
                  transition={{ duration: n.duration / 1000, ease: 'linear' }}
                />
              )}
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

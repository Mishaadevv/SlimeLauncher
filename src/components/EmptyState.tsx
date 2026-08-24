import { motion } from 'framer-motion';
import type { ReactNode } from 'react';
import { AppIcon } from './AppIcon';
import { useSettingsStore } from '@/store/settings-store';
import './EmptyState.css';

interface EmptyStateProps {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
}

export function EmptyState({ title, description, action, icon }: EmptyStateProps) {
  const { settings } = useSettingsStore();
  const anim = settings.animationsEnabled && !settings.reducedMotion;

  return (
    <motion.div
      className="empty-state"
      initial={anim ? { opacity: 0, y: 12 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="empty-icon">
        {icon || <AppIcon size={56} />}
      </div>
      <h3 className="empty-title">{title}</h3>
      {description && <p className="empty-desc">{description}</p>}
      {action && <div className="empty-action">{action}</div>}
    </motion.div>
  );
}

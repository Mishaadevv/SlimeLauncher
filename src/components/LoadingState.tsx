import { motion } from 'framer-motion';
import { AppIcon } from './AppIcon';
import { useSettingsStore } from '@/store/settings-store';
import './LoadingState.css';

interface LoadingStateProps {
  label?: string;
  sublabel?: string;
  size?: 'sm' | 'md' | 'lg';
}

export function LoadingState({ label = 'Loading...', sublabel, size = 'md' }: LoadingStateProps) {
  const { settings } = useSettingsStore();
  const anim = settings.animationsEnabled && !settings.reducedMotion;

  return (
    <div className={`loading-state loading-${size}`}>
      <div className="loading-blob">
        <AppIcon size={size === 'lg' ? 72 : size === 'sm' ? 32 : 48} />
        {anim && (
          <motion.div
            className="loading-ring"
            animate={{ rotate: 360 }}
            transition={{ duration: 2.4, repeat: Infinity, ease: 'linear' }}
          />
        )}
      </div>
      <motion.p
        className="loading-label"
        initial={anim ? { opacity: 0, y: 6 } : false}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1, duration: 0.3 }}
      >
        {label}
      </motion.p>
      {sublabel && <p className="loading-sublabel">{sublabel}</p>}
    </div>
  );
}

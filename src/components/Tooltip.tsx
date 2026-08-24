import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useSettingsStore } from '@/store/settings-store';
import './Tooltip.css';

interface TooltipProps {
  label: string;
  side?: 'right' | 'top' | 'bottom' | 'left';
  children: ReactNode;
  delay?: number;
}

export function Tooltip({ label, side = 'right', children, delay = 300 }: TooltipProps) {
  const [show, setShow] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { settings } = useSettingsStore();
  const anim = settings.animationsEnabled && !settings.reducedMotion;

  // Without this cleanup a quick hover would leave a pending timer that opens
  // the tooltip after the cursor is already gone — and it would stay open.
  const clearTimer = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };
  useEffect(() => clearTimer, []);

  return (
    <div
      className="tooltip-wrap"
      onMouseEnter={() => {
        clearTimer();
        timer.current = setTimeout(() => setShow(true), delay);
      }}
      onMouseLeave={() => {
        clearTimer();
        setShow(false);
      }}
    >
      {children}
      <AnimatePresence>
        {show && (
          <motion.div
            className={`tooltip tooltip-${side}`}
            initial={anim ? { opacity: 0, scale: 0.9 } : false}
            animate={{ opacity: 1, scale: 1 }}
            exit={anim ? { opacity: 0, scale: 0.9 } : undefined}
            transition={{ duration: 0.15 }}
          >
            {label}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

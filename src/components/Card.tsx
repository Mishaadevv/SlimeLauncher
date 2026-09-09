import { motion, type HTMLMotionProps } from 'framer-motion';
import { forwardRef, type ReactNode } from 'react';
import { useSettingsStore } from '@/store/settings-store';
import './Card.css';

interface CardProps extends Omit<HTMLMotionProps<'div'>, 'ref'> {
  children: ReactNode;
  hover?: boolean;
  interactive?: boolean;
  glow?: boolean;
}

export const Card = forwardRef<HTMLDivElement, CardProps>(
  ({ children, hover = false, interactive = false, glow = false, className, ...rest }, ref) => {
    const { settings } = useSettingsStore();
    const anim = settings.animationsEnabled && !settings.reducedMotion;

    return (
      <motion.div
        ref={ref}
        className={`card ${hover ? 'card-hover' : ''} ${interactive ? 'card-interactive' : ''} ${glow ? 'card-glow' : ''} ${className || ''}`}
        whileHover={anim && hover ? { y: -3, scale: 1.01 } : undefined}
        whileTap={anim && interactive ? { scale: 0.98 } : undefined}
        transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
        {...rest}
      >
        {children}
      </motion.div>
    );
  }
);

Card.displayName = 'Card';

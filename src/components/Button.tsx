import { motion, type HTMLMotionProps } from 'framer-motion';
import { forwardRef } from 'react';
import { useSettingsStore } from '@/store/settings-store';
import './Button.css';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends Omit<HTMLMotionProps<'button'>, 'ref'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: React.ReactNode;
  fullWidth?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', loading, icon, fullWidth, children, className, disabled, ...rest }, ref) => {
    const { settings } = useSettingsStore();
    const anim = settings.animationsEnabled && !settings.reducedMotion;
    const intensity = settings.animationIntensity;

    return (
      <motion.button
        ref={ref}
        className={`btn btn-${variant} btn-${size} ${fullWidth ? 'btn-full' : ''} ${className || ''}`}
        disabled={disabled || loading}
        whileHover={anim && !disabled ? { scale: 1 + 0.02 * intensity } : undefined}
        whileTap={anim && !disabled ? { scale: 1 - 0.04 * intensity } : undefined}
        transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}
        {...rest}
      >
        {loading && <span className="btn-spinner" />}
        {icon && !loading && <span className="btn-icon">{icon}</span>}
        {children && <span className="btn-label">{children as React.ReactNode}</span>}
      </motion.button>
    );
  }
);

Button.displayName = 'Button';

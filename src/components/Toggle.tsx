import { motion } from 'framer-motion';
import { useSettingsStore } from '@/store/settings-store';
import './Toggle.css';

interface ToggleProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
}

export function Toggle({ checked, onChange, disabled, label }: ToggleProps) {
  const { settings } = useSettingsStore();
  const anim = settings.animationsEnabled && !settings.reducedMotion;

  return (
    <button
      type="button"
      className={`toggle ${checked ? 'toggle-on' : ''} ${disabled ? 'toggle-disabled' : ''}`}
      onClick={() => !disabled && onChange(!checked)}
      role="switch"
      aria-checked={checked}
      aria-label={label}
    >
      <motion.span
        className="toggle-knob"
        animate={anim ? { x: checked ? 20 : 0 } : undefined}
        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
      />
    </button>
  );
}

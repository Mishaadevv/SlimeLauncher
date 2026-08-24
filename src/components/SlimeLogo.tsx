import { motion } from 'framer-motion';
import { useSettingsStore } from '@/store/settings-store';

interface SlimeLogoProps {
  size?: number;
  animated?: boolean;
  glow?: boolean;
}

/**
 * Original SlimeLauncher branding — a minimalist slime blob with two eyes.
 * Not a Creeper, not a Minecraft cube. A soft organic blob that subtly
 * morphs when animated. Used in the logo, splash, loading & empty states.
 */
export function SlimeLogo({ size = 40, animated = false, glow = true }: SlimeLogoProps) {
  const { settings } = useSettingsStore();
  const shouldAnimate = animated && settings.animationsEnabled && !settings.reducedMotion;

  return (
    <div
      style={{ width: size, height: size, position: 'relative' }}
      className={glow ? 'slime-glow' : ''}
    >
      <motion.svg
        width={size}
        height={size}
        viewBox="0 0 100 100"
        initial={shouldAnimate ? { scale: 0.9 } : false}
        animate={shouldAnimate ? { scale: [0.9, 1.02, 0.95, 1] } : undefined}
        transition={shouldAnimate ? { duration: 3, repeat: Infinity, ease: 'easeInOut' } : undefined}
      >
        <defs>
          <radialGradient id="slimeGrad" cx="40%" cy="35%" r="70%">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.95" />
            <stop offset="60%" stopColor="var(--accent-2)" stopOpacity="0.85" />
            <stop offset="100%" stopColor="var(--accent-3)" stopOpacity="0.7" />
          </radialGradient>
          <filter id="slimeBlur" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="1.2" />
          </filter>
        </defs>
        {/* Blob body — organic, slightly asymmetric */}
        <motion.path
          d="M50 12 C72 12 88 28 88 50 C88 64 80 76 68 82 C60 86 52 88 50 88 C48 88 40 86 32 82 C20 76 12 64 12 50 C12 28 28 12 50 12 Z"
          fill="url(#slimeGrad)"
          filter="url(#slimeBlur)"
          animate={shouldAnimate ? {
            d: [
              'M50 12 C72 12 88 28 88 50 C88 64 80 76 68 82 C60 86 52 88 50 88 C48 88 40 86 32 82 C20 76 12 64 12 50 C12 28 28 12 50 12 Z',
              'M50 14 C74 14 90 30 86 52 C84 66 78 78 66 84 C58 88 52 86 50 86 C48 86 42 88 34 84 C22 78 14 66 14 50 C14 28 26 14 50 14 Z',
              'M50 12 C72 12 88 28 88 50 C88 64 80 76 68 82 C60 86 52 88 50 88 C48 88 40 86 32 82 C20 76 12 64 12 50 C12 28 28 12 50 12 Z',
            ],
          } : undefined}
          transition={shouldAnimate ? { duration: 4, repeat: Infinity, ease: 'easeInOut' } : undefined}
        />
        {/* Highlight */}
        <ellipse cx="38" cy="32" rx="14" ry="9" fill="white" opacity="0.18" />
        {/* Eyes — two small darkvals, the signature slime look */}
        <ellipse cx="38" cy="52" rx="5" ry="7" fill="#0a0e0a" opacity="0.85" />
        <ellipse cx="62" cy="52" rx="5" ry="7" fill="#0a0e0a" opacity="0.85" />
        <ellipse cx="39.5" cy="50" rx="1.6" ry="2" fill="white" opacity="0.7" />
        <ellipse cx="63.5" cy="50" rx="1.6" ry="2" fill="white" opacity="0.7" />
        {/* Mouth — subtle smile */}
        <path d="M42 66 Q50 70 58 66" stroke="#0a0e0a" strokeWidth="2" strokeLinecap="round" fill="none" opacity="0.6" />
      </motion.svg>
    </div>
  );
}

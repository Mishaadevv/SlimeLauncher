import appIcon from '@/assets/app-icon.png';

interface AppIconProps {
  size?: number;
  className?: string;
}

/**
 * The SlimeLauncher application icon (the real app branding image),
 * used in place of the old green slime blob in the sidebar, titlebar,
 * home and auth screens.
 */
export function AppIcon({ size = 32, className }: AppIconProps) {
  return (
    <img
      src={appIcon}
      alt="SlimeLauncher"
      width={size}
      height={size}
      className={className}
      style={{ objectFit: 'contain', borderRadius: size > 24 ? 8 : 4 }}
      draggable={false}
    />
  );
}

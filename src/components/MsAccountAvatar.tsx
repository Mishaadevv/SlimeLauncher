import { useEffect, useState } from 'react';
import { Gamepad2 } from 'lucide-react';

// The Mojang skin texture URL is stable per account; fetch it and cache for a
// short while. The TTL matters: a module-level forever-cache kept showing the
// previous account's skin after the user linked a different Microsoft account.
const CACHE_TTL_MS = 30_000;
let cached: string | null | undefined;
let cachedAt = 0;
let pending: Promise<string | null> | null = null;

function fetchSkinUrl(): Promise<string | null> {
  if (cached !== undefined && Date.now() - cachedAt < CACHE_TTL_MS) {
    return Promise.resolve(cached);
  }
  if (!pending) {
    pending = window.slime.ms
      .profile()
      .then((res) => {
        cached = res?.ok && res.profile?.skinUrl ? (res.profile.skinUrl as string) : null;
        cachedAt = Date.now();
        pending = null;
        return cached;
      })
      .catch(() => {
        cached = null;
        cachedAt = Date.now();
        pending = null;
        return null;
      });
  }
  return pending;
}

// Renders the player's head cropped from the full 64x64 skin texture
// (head is the top-left 8x8 block). Falls back to a Gamepad2 icon.
export function MsAccountAvatar({ active, size = 28 }: { active: boolean; size?: number }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    setFailed(false);
    void fetchSkinUrl().then((u) => { if (alive) setUrl(u); });
    return () => { alive = false; };
  }, [active]);

  if (!active || !url || failed) {
    return <Gamepad2 size={size} />;
  }
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: Math.max(6, size / 4),
        overflow: 'hidden',
        // Two layers of the same texture, so the avatar shows the recognizable
        // head: the face block at (8,8) plus the hat/overlay block at (40,8)
        // drawn over it (transparent except the hat itself). With the texture
        // scaled by size*8, texture offset n maps to n*size/8 pixels.
        backgroundImage: `url(${url}), url(${url})`,
        backgroundSize: `${size * 8}px ${size * 8}px, ${size * 8}px ${size * 8}px`,
        backgroundPosition: `-${size}px -${size}px, -${size * 5}px -${size}px`,
        imageRendering: 'pixelated',
        flexShrink: 0,
        // Must be backgroundColor, not the `background` shorthand: the
        // shorthand would reset background-image to none and hide the head.
        backgroundColor: 'var(--bg-2)',
      }}
      aria-label="Microsoft account avatar"
    >
      <img
        src={url}
        alt=""
        style={{ display: 'none' }}
        onError={() => setFailed(true)}
      />
    </div>
  );
}

import { useEffect, useRef } from 'react';
import { useSettingsStore } from '@/store/settings-store';
import './Background.css';

/**
 * Dynamic background. GPU-friendly: uses CSS transforms and a single
 * canvas for particles. Styles: gradient, slime (blobs), particles, none.
 */
export function Background() {
  const { settings } = useSettingsStore();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const style = settings.backgroundStyle;
  const anim = settings.animationsEnabled && !settings.reducedMotion;

  // Particles layer
  useEffect(() => {
    if (style !== 'particles' || !anim) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    let w = 0, h = 0;
    const DPR = Math.min(window.devicePixelRatio || 1, 2);
    const particles: { x: number; y: number; r: number; vx: number; vy: number; o: number }[] = [];

    const resize = () => {
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = w * DPR;
      canvas.height = h * DPR;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    };
    resize();

    const count = Math.min(60, Math.floor((w * h) / 30000));
    for (let i = 0; i < count; i++) {
      particles.push({
        x: Math.random() * w,
        y: Math.random() * h,
        r: 1 + Math.random() * 2.5,
        vx: (Math.random() - 0.5) * 0.15,
        vy: (Math.random() - 0.5) * 0.15,
        o: 0.1 + Math.random() * 0.3,
      });
    }

    const tick = () => {
      ctx.clearRect(0, 0, w, h);
      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0) p.x = w;
        if (p.x > w) p.x = 0;
        if (p.y < 0) p.y = h;
        if (p.y > h) p.y = 0;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(74, 222, 128, ${p.o})`;
        ctx.fill();
      }
      raf = requestAnimationFrame(tick);
    };
    tick();

    window.addEventListener('resize', resize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, [style, anim]);

  const isVideo = settings.customBackgroundImage?.match(/\.(mp4|webm)$/i);

  return (
    <div className={`background background-${style}`} aria-hidden>
      {/* Base gradient */}
      <div className="bg-base" />
      
      {/* Custom Image/Video */}
      {style === 'custom' && settings.customBackgroundImage && (
        <div 
          className="bg-custom" 
          style={{ 
            opacity: settings.customBackgroundOpacity,
            filter: `blur(${settings.customBackgroundBlur}px)`,
          }}
        >
          {isVideo ? (
            <video 
              src={`local://${encodeURIComponent(settings.customBackgroundImage)}`}
              autoPlay 
              loop 
              muted 
              playsInline 
              className="bg-custom-media"
            />
          ) : (
            <img 
              src={`local://${encodeURIComponent(settings.customBackgroundImage)}`} 
              alt="" 
              className="bg-custom-media"
            />
          )}
        </div>
      )}

      {/* Slime blobs */}
      {style === 'slime' && (
        <>
          <div className="bg-blob bg-blob-1" />
          <div className="bg-blob bg-blob-2" />
          <div className="bg-blob bg-blob-3" />
        </>
      )}
      {/* Subtle grid for depth */}
      <div className="bg-grid" />
      {/* Particles canvas */}
      <canvas ref={canvasRef} className="bg-canvas" />
      {/* Vignette */}
      <div className="bg-vignette" />
    </div>
  );
}
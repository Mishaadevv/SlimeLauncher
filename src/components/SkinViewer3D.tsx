import { useEffect, useRef, useState } from 'react';
import { RotateCw } from 'lucide-react';
import { t } from '@/lib/i18n';
import './SkinViewer3D.css';

export type SkinView = 'front' | 'side' | 'back';

export interface SkinViewer3DProps {
  /** Skin image: URL or data: URL. Falls back to a generated default skin when null. */
  skinSrc?: string | null;
  /** Cape image: URL or data: URL. */
  capeSrc?: string | null;
  variant?: 'classic' | 'slim';
  width?: number;
  height?: number;
  /** Initial camera view. */
  defaultView?: SkinView;
  /** Start with the turntable spin enabled. */
  autoRotate?: boolean;
}

/*
 * A tiny software 3D renderer for the Minecraft player model, drawn with the
 * 2D canvas API (no WebGL, no dependencies). Each model part is a box; every
 * box face carries a UV rectangle into the 64x64 skin texture. Faces are
 * sorted back-to-front (painter's algorithm) and drawn with an affine texture
 * transform plus Minecraft-style per-face shading.
 *
 * Model space: 1 unit = 1 skin pixel. The character is 32 units tall (head
 * top at y = 32, feet at y = 0), facing +Z. The character's right side is -X
 * (right arm hangs at x < 0), matching the vanilla player model.
 */

type Vec3 = [number, number, number];

interface TexRect {
  u: number;
  v: number;
  w: number;
  h: number;
}

interface BoxSpec {
  cx: number;
  cy: number;
  cz: number;
  w: number;
  h: number;
  d: number;
}

interface FacesTex {
  px: TexRect; // +X face (character's left side)
  mx: TexRect; // -X face (character's right side)
  pz: TexRect; // +Z face (front)
  mz: TexRect; // -Z face (back)
  py: TexRect; // +Y face (top)
  my: TexRect; // -Y face (bottom)
}

interface Face3D {
  pts: [Vec3, Vec3, Vec3, Vec3];
  center: Vec3;
  tex: TexRect;
  shade: number;
  /** The texture region with its shade baked in, pre-rendered once. */
  canvas: HTMLCanvasElement;
  /** Perspective-correction grid: the face is split into nx×ny sub-quads. */
  nx: number;
  ny: number;
}

const R = (u: number, v: number, w: number, h: number): TexRect => ({ u, v, w, h });

// Minecraft-style face shading: top brightest, bottom darkest, sides in between.
const SHADE = { px: 0.6, mx: 0.6, pz: 0.8, mz: 0.8, py: 1.0, my: 0.5 };

// Corner/UV mapping. The quad corner order maps to the texture rect as:
// pts[0] <-> (u,v), pts[1] <-> (u+w,v), pts[2] <-> (u,v+h), pts[3] <-> (u+w,v+h).
// The corners are derived by "folding" the box so all adjacent faces share
// edges (same folding as Minecraft's box UVs).
type SkinSource = HTMLImageElement | HTMLCanvasElement;

function makeBox(box: BoxSpec, tex: FacesTex, img: SkinSource): Face3D[] {
  // HD skins/capes are scaled-up versions of the 64x64 (skin) / 64x32 (cape)
  // UV grid, so the UV rects must be scaled by the actual image size before
  // sampling. Horizontal scale is always width/64; vertical is height/64 for
  // square images and height/32 for 2:1 (legacy-style) ones.
  const imgW = 'naturalWidth' in img ? img.naturalWidth : img.width;
  const imgH = 'naturalHeight' in img ? img.naturalHeight : img.height;
  const sx = imgW / 64;
  const sy = imgW === imgH ? imgH / 64 : imgH / 32;
  const x0 = box.cx - box.w / 2;
  const x1 = box.cx + box.w / 2;
  const y0 = box.cy - box.h / 2;
  const y1 = box.cy + box.h / 2;
  const z0 = box.cz - box.d / 2;
  const z1 = box.cz + box.d / 2;

  const faces: Array<{ pts: [Vec3, Vec3, Vec3, Vec3]; tex: TexRect; key: keyof FacesTex }> = [
    {
      // +X
      pts: [
        [x1, y1, z1],
        [x1, y1, z0],
        [x1, y0, z1],
        [x1, y0, z0],
      ],
      tex: tex.px,
      key: 'px',
    },
    {
      // -X
      pts: [
        [x0, y1, z0],
        [x0, y1, z1],
        [x0, y0, z0],
        [x0, y0, z1],
      ],
      tex: tex.mx,
      key: 'mx',
    },
    {
      // +Z
      pts: [
        [x0, y1, z1],
        [x1, y1, z1],
        [x0, y0, z1],
        [x1, y0, z1],
      ],
      tex: tex.pz,
      key: 'pz',
    },
    {
      // -Z
      pts: [
        [x1, y1, z0],
        [x0, y1, z0],
        [x1, y0, z0],
        [x0, y0, z0],
      ],
      tex: tex.mz,
      key: 'mz',
    },
    {
      // +Y
      pts: [
        [x0, y1, z0],
        [x1, y1, z0],
        [x0, y1, z1],
        [x1, y1, z1],
      ],
      tex: tex.py,
      key: 'py',
    },
    {
      // -Y
      pts: [
        [x1, y0, z0],
        [x0, y0, z0],
        [x1, y0, z1],
        [x0, y0, z1],
      ],
      tex: tex.my,
      key: 'my',
    },
  ];

  return faces.map((f) => {
    const center: Vec3 = [
      (f.pts[0][0] + f.pts[2][0]) / 2,
      (f.pts[0][1] + f.pts[2][1]) / 2,
      (f.pts[0][2] + f.pts[1][2]) / 2,
    ];
    // Bake the texture region + per-face shade into a small offscreen canvas
    // once. The shade must only darken the face's own pixels — a global fill
    // would also darken the base face behind a transparent overlay layer.
    const { u, v, w, h } = f.tex;
    const su = u * sx;
    const sv = v * sy;
    const sw = w * sx;
    const sh = h * sy;
    const cw = Math.max(1, Math.round(w));
    const ch = Math.max(1, Math.round(h));
    const c = document.createElement('canvas');
    c.width = cw;
    c.height = ch;
    const g = c.getContext('2d')!;
    g.imageSmoothingEnabled = false;
    g.drawImage(img, su, sv, sw, sh, 0, 0, cw, ch);
    g.globalCompositeOperation = 'source-atop';
    g.fillStyle = `rgba(0, 0, 0, ${1 - SHADE[f.key]})`;
    g.fillRect(0, 0, cw, ch);
    return {
      pts: f.pts,
      center,
      tex: f.tex,
      shade: SHADE[f.key],
      img,
      canvas: c,
      // ~2 texture px per cell keeps the affine-per-cell error small, so the
      // drawn face tracks the true perspective quad instead of skewing it.
      nx: Math.max(1, Math.round(cw / 2)),
      ny: Math.max(1, Math.round(ch / 2)),
    };
  });
}

const HEAD_TEX: FacesTex = {
  px: R(16, 8, 8, 8),
  mx: R(0, 8, 8, 8),
  pz: R(8, 8, 8, 8),
  mz: R(24, 8, 8, 8),
  py: R(8, 0, 8, 8),
  my: R(16, 0, 8, 8),
};
const HAT_TEX: FacesTex = {
  px: R(48, 8, 8, 8),
  mx: R(32, 8, 8, 8),
  pz: R(40, 8, 8, 8),
  mz: R(56, 8, 8, 8),
  py: R(40, 0, 8, 8),
  my: R(48, 0, 8, 8),
};
const BODY_TEX: FacesTex = {
  px: R(28, 20, 4, 12),
  mx: R(16, 20, 4, 12),
  pz: R(20, 20, 8, 12),
  mz: R(36, 20, 4, 12),
  py: R(20, 16, 8, 4),
  my: R(28, 16, 8, 4),
};
const BODY_OVERLAY_TEX: FacesTex = {
  px: R(28, 36, 4, 12),
  mx: R(16, 36, 4, 12),
  pz: R(20, 36, 8, 12),
  mz: R(36, 36, 4, 12),
  py: R(20, 32, 8, 4),
  my: R(28, 32, 8, 4),
};
const ARM_R_TEX: FacesTex = {
  px: R(48, 20, 4, 12),
  mx: R(40, 20, 4, 12),
  pz: R(44, 20, 4, 12),
  mz: R(52, 20, 4, 12),
  py: R(44, 16, 4, 4),
  my: R(48, 16, 4, 4),
};
const ARM_R_OVERLAY_TEX: FacesTex = {
  px: R(48, 36, 4, 12),
  mx: R(40, 36, 4, 12),
  pz: R(44, 36, 4, 12),
  mz: R(52, 36, 4, 12),
  py: R(44, 32, 4, 4),
  my: R(48, 32, 4, 4),
};
const ARM_L_TEX: FacesTex = {
  px: R(40, 52, 4, 12),
  mx: R(32, 52, 4, 12),
  pz: R(36, 52, 4, 12),
  mz: R(44, 52, 4, 12),
  py: R(36, 48, 4, 4),
  my: R(40, 48, 4, 4),
};
const ARM_L_OVERLAY_TEX: FacesTex = {
  px: R(56, 36, 4, 12),
  mx: R(48, 36, 4, 12),
  pz: R(52, 36, 4, 12),
  mz: R(60, 36, 4, 12),
  py: R(52, 32, 4, 4),
  my: R(56, 32, 4, 4),
};
const LEG_R_TEX: FacesTex = {
  px: R(8, 20, 4, 12),
  mx: R(0, 20, 4, 12),
  pz: R(4, 20, 4, 12),
  mz: R(12, 20, 4, 12),
  py: R(4, 16, 4, 4),
  my: R(8, 16, 4, 4),
};
const LEG_R_OVERLAY_TEX: FacesTex = {
  px: R(8, 36, 4, 12),
  mx: R(0, 36, 4, 12),
  pz: R(4, 36, 4, 12),
  mz: R(12, 36, 4, 12),
  py: R(4, 32, 4, 4),
  my: R(8, 32, 4, 4),
};
const LEG_L_TEX: FacesTex = {
  px: R(24, 52, 4, 12),
  mx: R(16, 52, 4, 12),
  pz: R(20, 52, 4, 12),
  mz: R(28, 52, 4, 12),
  py: R(20, 48, 4, 4),
  my: R(24, 48, 4, 4),
};
const LEG_L_OVERLAY_TEX: FacesTex = {
  px: R(24, 36, 4, 12),
  mx: R(16, 36, 4, 12),
  pz: R(20, 36, 4, 12),
  mz: R(28, 36, 4, 12),
  py: R(20, 32, 4, 4),
  my: R(24, 32, 4, 4),
};

// Slim (Alex) arms — 3 px wide instead of 4.
const ARM_R_SLIM_TEX: FacesTex = {
  px: R(47, 20, 4, 12),
  mx: R(40, 20, 4, 12),
  pz: R(44, 20, 3, 12),
  mz: R(50, 20, 3, 12),
  py: R(44, 16, 3, 4),
  my: R(47, 16, 3, 4),
};
const ARM_R_SLIM_OVERLAY_TEX: FacesTex = {
  px: R(47, 36, 4, 12),
  mx: R(40, 36, 4, 12),
  pz: R(44, 36, 3, 12),
  mz: R(50, 36, 3, 12),
  py: R(44, 32, 3, 4),
  my: R(47, 32, 3, 4),
};
const ARM_L_SLIM_TEX: FacesTex = {
  px: R(39, 52, 3, 12),
  mx: R(32, 52, 4, 12),
  pz: R(36, 52, 3, 12),
  mz: R(42, 52, 3, 12),
  py: R(36, 48, 3, 4),
  my: R(39, 48, 3, 4),
};
const ARM_L_SLIM_OVERLAY_TEX: FacesTex = {
  px: R(47, 36, 3, 12),
  mx: R(40, 36, 4, 12),
  pz: R(44, 36, 3, 12),
  mz: R(50, 36, 3, 12),
  py: R(44, 32, 3, 4),
  my: R(47, 32, 3, 4),
};

// Cape box: 10 wide x 16 tall x 1 deep, hanging from the shoulders behind the
// body. Cape texture layout: outer (back) face (0,0)-(10,16), inner (10,0),
// top (0,16), bottom (10,16), sides (20,0)/(21,0).
const CAPE_TEX: FacesTex = {
  px: R(21, 0, 1, 16),
  mx: R(20, 0, 1, 16),
  pz: R(10, 0, 10, 16),
  mz: R(0, 0, 10, 16),
  py: R(0, 16, 10, 1),
  my: R(10, 16, 10, 1),
};

function buildSkinFaces(img: SkinSource, variant: 'classic' | 'slim'): Face3D[] {
  // Legacy 2:1 skins (64x32 and HD variants like 128x64) have no overlay layer
  // and reuse the right limbs for the left ones (that's how the old format was
  // rendered) — detect by aspect ratio, not pixel height.
  const imgW = 'naturalWidth' in img ? img.naturalWidth : img.width;
  const imgH = 'naturalHeight' in img ? img.naturalHeight : img.height;
  const legacy = imgW === imgH * 2;
  const slim = variant === 'slim' && !legacy;
  const armW = slim ? 3 : 4;
  // Slim arms hug the body: inner edge stays flush with the torso.
  const rightArmCx = -(4 + armW / 2);
  const leftArmCx = 4 + armW / 2;

  const faces: Face3D[] = [];
  const add = (box: BoxSpec, tex: FacesTex) => faces.push(...makeBox(box, tex, img));

  // Head + hat
  add({ cx: 0, cy: 28, cz: 0, w: 8, h: 8, d: 8 }, HEAD_TEX);
  if (!legacy) {
    add({ cx: 0, cy: 28, cz: 0, w: 8.5, h: 8.5, d: 8.5 }, HAT_TEX);
  }

  // Body + overlay
  add({ cx: 0, cy: 18, cz: 0, w: 8, h: 12, d: 4 }, BODY_TEX);
  if (!legacy) {
    add({ cx: 0, cy: 18, cz: 0, w: 8.5, h: 12.5, d: 4.5 }, BODY_OVERLAY_TEX);
  }

  // Arms
  if (slim) {
    add({ cx: rightArmCx, cy: 18, cz: 0, w: 3, h: 12, d: 4 }, ARM_R_SLIM_TEX);
    add({ cx: leftArmCx, cy: 18, cz: 0, w: 3, h: 12, d: 4 }, ARM_L_SLIM_TEX);
    if (!legacy) {
      add({ cx: rightArmCx, cy: 18, cz: 0, w: 3.5, h: 12.5, d: 4.5 }, ARM_R_SLIM_OVERLAY_TEX);
      add({ cx: leftArmCx, cy: 18, cz: 0, w: 3.5, h: 12.5, d: 4.5 }, ARM_L_SLIM_OVERLAY_TEX);
    }
  } else {
    add({ cx: rightArmCx, cy: 18, cz: 0, w: 4, h: 12, d: 4 }, ARM_R_TEX);
    if (legacy) {
      // 64x32: left arm reuses the right arm texture.
      add({ cx: leftArmCx, cy: 18, cz: 0, w: 4, h: 12, d: 4 }, ARM_R_TEX);
    } else {
      add({ cx: leftArmCx, cy: 18, cz: 0, w: 4, h: 12, d: 4 }, ARM_L_TEX);
      add({ cx: rightArmCx, cy: 18, cz: 0, w: 4.5, h: 12.5, d: 4.5 }, ARM_R_OVERLAY_TEX);
      add({ cx: leftArmCx, cy: 18, cz: 0, w: 4.5, h: 12.5, d: 4.5 }, ARM_L_OVERLAY_TEX);
    }
  }

  // Legs
  add({ cx: -2, cy: 6, cz: 0, w: 4, h: 12, d: 4 }, LEG_R_TEX);
  if (legacy) {
    add({ cx: 2, cy: 6, cz: 0, w: 4, h: 12, d: 4 }, LEG_R_TEX);
  } else {
    add({ cx: 2, cy: 6, cz: 0, w: 4, h: 12, d: 4 }, LEG_L_TEX);
    add({ cx: -2, cy: 6, cz: 0, w: 4.5, h: 12.5, d: 4.5 }, LEG_R_OVERLAY_TEX);
    add({ cx: 2, cy: 6, cz: 0, w: 4.5, h: 12.5, d: 4.5 }, LEG_L_OVERLAY_TEX);
  }

  return faces;
}

function buildCapeFaces(img: SkinSource): Face3D[] {
  return makeBox({ cx: 0, cy: 16, cz: -3.5, w: 10, h: 16, d: 1 }, CAPE_TEX, img);
}

// Procedural default "Steve" skin so the preview always shows a character.
function makeDefaultSkin(variant: 'classic' | 'slim'): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 64, 64);

  const SKIN = '#c68642';
  const SKIN_DARK = '#a96f34';
  const HAIR = '#3f2a1a';
  const SHIRT = '#00afaf';
  const SHIRT_DARK = '#009999';
  const PANTS = '#2f3e8c';
  const PANTS_DARK = '#27356f';
  const SHOES = '#4a4a4a';

  // Head — skin everywhere except hair on top/back.
  g.fillStyle = SKIN;
  g.fillRect(0, 8, 32, 8); // four side faces
  g.fillRect(8, 0, 8, 8); // top
  g.fillRect(16, 0, 8, 8); // bottom
  g.fillStyle = HAIR;
  g.fillRect(8, 0, 8, 8); // hair on top
  g.fillRect(24, 8, 8, 8); // hair on back
  g.fillRect(8, 8, 8, 2); // hair fringe across the forehead
  // Eyes + mouth
  g.fillStyle = '#ffffff';
  g.fillRect(10, 10, 2, 2);
  g.fillRect(14, 10, 2, 2);
  g.fillStyle = '#20242c';
  g.fillRect(10, 10, 1, 1);
  g.fillRect(15, 10, 1, 1);
  g.fillRect(11, 13, 2, 1);
  g.fillRect(14, 13, 1, 1);

  // Hat overlay (kept transparent except a subtle outline so it reads as 3D)
  g.strokeStyle = 'rgba(0,0,0,0.08)';
  g.strokeRect(40, 8, 8, 8);

  // Body — shirt
  g.fillStyle = SHIRT;
  g.fillRect(20, 20, 8, 12); // front
  g.fillRect(20, 16, 8, 4); // top
  g.fillStyle = SHIRT_DARK;
  g.fillRect(16, 20, 4, 12); // -X side
  g.fillRect(28, 20, 4, 12); // +X side
  g.fillRect(28, 16, 8, 4); // bottom
  g.fillRect(36, 20, 4, 12); // back

  // Right arm — sleeve + skin hand
  g.fillStyle = SHIRT;
  g.fillRect(40, 20, 4, 12); // outer
  g.fillRect(44, 20, 4, 8); // front (sleeve)
  g.fillStyle = SKIN;
  g.fillRect(44, 28, 4, 4); // hand
  g.fillStyle = SHIRT_DARK;
  g.fillRect(48, 20, 4, 12); // inner

  // Left arm (classic only uses the dedicated region when not slim)
  if (variant === 'slim') {
    g.fillStyle = SHIRT_DARK;
    g.fillRect(32, 52, 4, 12); // inner (-X)
    g.fillRect(39, 52, 3, 12); // outer (+X)
    g.fillStyle = SHIRT;
    g.fillRect(36, 52, 3, 8); // front
    g.fillStyle = SKIN;
    g.fillRect(36, 60, 3, 4); // hand
  } else {
    g.fillStyle = SHIRT_DARK;
    g.fillRect(32, 52, 4, 12); // inner (-X)
    g.fillRect(40, 52, 4, 12); // outer (+X)
    g.fillStyle = SHIRT;
    g.fillRect(36, 52, 4, 8); // front
    g.fillStyle = SKIN;
    g.fillRect(36, 60, 4, 4); // hand
  }

  // Legs — pants + shoes
  const paintLeg = (ox: number, front: number, top: number, shoes: number) => {
    g.fillStyle = PANTS_DARK;
    g.fillRect(ox, 20, 4, 12); // outer
    g.fillStyle = PANTS;
    g.fillRect(front, 20, 4, 12); // front
    g.fillRect(top, 16, 4, 4); // top
    g.fillStyle = SHOES;
    g.fillRect(shoes, 28, 4, 4); // shoes on the front
  };
  // Right leg
  paintLeg(0, 4, 4, 4);
  // Left leg
  g.fillStyle = PANTS_DARK;
  g.fillRect(24, 52, 4, 12); // outer
  g.fillStyle = PANTS;
  g.fillRect(20, 52, 4, 12); // front
  g.fillRect(20, 48, 4, 4); // top
  g.fillStyle = SHOES;
  g.fillRect(20, 60, 4, 4); // shoes

  return c;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // No crossOrigin: the renderer only draws from the images and never reads
    // canvas pixels back, so tainting is harmless and CORS can't block remote
    // skin URLs (e.g. textures.minecraft.net).
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load image`));
    img.src = src;
  });
}

// Camera azimuth (radians) per view. The character faces +Z (the skin's front
// face is on +Z), and the projection looks along +Z from the -Z side, so the
// face is visible at yaw = PI and the back at yaw = 0.
const VIEW_YAW: Record<SkinView, number> = {
  front: Math.PI,
  side: Math.PI / 2,
  back: 0,
};

// Which view the current yaw is closest to — used to keep the pill highlight
// in sync with the model while it spins or is dragged.
function nearestView(yaw: number): SkinView {
  const a = ((yaw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const candidates: Array<[SkinView, number]> = [
    ['back', 0],
    ['side', Math.PI / 2],
    ['front', Math.PI],
    ['side', (3 * Math.PI) / 2],
  ];
  let best: SkinView = 'front';
  let bestDist = Infinity;
  for (const [v, ang] of candidates) {
    const d = Math.min(Math.abs(a - ang), 2 * Math.PI - Math.abs(a - ang));
    if (d < bestDist) {
      bestDist = d;
      best = v;
    }
  }
  return best;
}

const CAM_DIST = 66;
const CAM_PITCH = 0.14;
const FOV = (40 * Math.PI) / 180;

interface ProjectedFace {
  face: Face3D;
  /** (ny+1)×(nx+1) grid of projected face corners (bilinear in 3D). */
  grid: Array<Array<{ x: number; y: number }>>;
  depth: number;
}

interface SimState {
  yaw: number;
  targetYaw: number;
  rotating: boolean;
  dragging: boolean;
  /** True once the user dragged away from the selected view. */
  viewOverridden: boolean;
  lastX: number;
  skinFaces: Face3D[];
  capeFaces: Face3D[];
  ready: boolean;
}

export function SkinViewer3D({
  skinSrc,
  capeSrc,
  variant = 'classic',
  width = 280,
  height = 320,
  defaultView = 'front',
  autoRotate = true,
}: SkinViewer3DProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [view, setView] = useState<SkinView>(defaultView);
  const [rotating, setRotating] = useState(autoRotate);
  // Which view pill is actually facing the camera right now (tracks the real
  // yaw, so the highlight stays in sync with the spinning/dragged model).
  const [activeView, setActiveView] = useState<SkinView>(defaultView);
  const lastActiveRef = useRef<SkinView>(defaultView);

  const simRef = useRef<SimState>({
    yaw: VIEW_YAW[defaultView],
    targetYaw: VIEW_YAW[defaultView],
    rotating: autoRotate,
    dragging: false,
    viewOverridden: false,
    lastX: 0,
    skinFaces: [],
    capeFaces: [],
    ready: false,
  });

  // Load the skin image and rebuild the model whenever inputs change.
  useEffect(() => {
    let alive = true;
    const sim = simRef.current;
    sim.ready = false;
    sim.skinFaces = [];

    const build = (img: SkinSource, cape: SkinSource | null) => {
      if (!alive) return;
      sim.skinFaces = buildSkinFaces(img, variant);
      sim.capeFaces = cape ? buildCapeFaces(cape) : [];
      sim.ready = true;
    };

    let skinImg: SkinSource | null = null;
    let capeImg: SkinSource | null = null;

    const finish = () => {
      if (skinImg) build(skinImg, capeImg);
    };

    if (skinSrc) {
      loadImage(skinSrc)
        .then((img) => {
          skinImg = img;
          finish();
        })
        .catch(() => {
          skinImg = makeDefaultSkin(variant);
          finish();
        });
    } else {
      skinImg = makeDefaultSkin(variant);
      finish();
    }

    if (capeSrc) {
      loadImage(capeSrc)
        .then((img) => {
          capeImg = img;
          finish();
        })
        .catch(() => {
          capeImg = null;
          finish();
        });
    }

    return () => {
      alive = false;
    };
  }, [skinSrc, capeSrc, variant]);

  // View buttons snap the model; turning spin off eases back to the view
  // (unless the user dragged somewhere else since).
  useEffect(() => {
    const sim = simRef.current;
    sim.rotating = rotating;
    sim.viewOverridden = false;
    sim.targetYaw = VIEW_YAW[view];
  }, [view, rotating]);

  // Animation + render loop.
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const sim = simRef.current;
      if (sim.rotating && !sim.dragging) {
        sim.yaw += 0.008;
      } else if (!sim.dragging && !sim.viewOverridden) {
        let diff = sim.targetYaw - sim.yaw;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff)); // wrap to [-PI, PI]
        sim.yaw += diff * 0.14;
        if (Math.abs(diff) < 0.001) sim.yaw = sim.targetYaw;
      }
      // Keep the highlighted pill in sync with the actual facing.
      const nearest = nearestView(sim.yaw);
      if (nearest !== lastActiveRef.current) {
        lastActiveRef.current = nearest;
        setActiveView(nearest);
      }
      // Gentle idle cape flutter so the cape clearly moves *with* the body
      // instead of reading as a stiff board rotating the other way.
      const capeSwing = 0.05 * Math.sin(performance.now() * 0.0015);
      render(canvasRef.current, sim, width, height, capeSwing);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [width, height]);

  return (
    <div className="skin-viewer3d">
      <div
        className="skin-viewer3d-canvas"
        style={{ width, height }}
        onPointerDown={(e) => {
          const sim = simRef.current;
          sim.dragging = true;
          sim.lastX = e.clientX;
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const sim = simRef.current;
          if (!sim.dragging) return;
          const dx = e.clientX - sim.lastX;
          sim.lastX = e.clientX;
          if (dx !== 0) sim.viewOverridden = true;
          sim.yaw += dx * 0.008;
        }}
        onPointerUp={(e) => {
          simRef.current.dragging = false;
          (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
        }}
        onPointerCancel={() => {
          simRef.current.dragging = false;
        }}
      >
        <canvas ref={canvasRef} style={{ width, height }} />
      </div>
      <div className="skin-viewer3d-controls">
        <div className="skin-viewer3d-pills">
          {(Object.keys(VIEW_YAW) as SkinView[]).map((v) => (
            <button
              key={v}
              className={`skin-viewer3d-pill ${activeView === v ? 'skin-viewer3d-pill-active' : ''}`}
              onClick={() => {
                setRotating(false);
                setView(v);
              }}
            >
              {v === 'front' ? 'Front' : v === 'side' ? 'Side' : 'Back'}
            </button>
          ))}
        </div>
        <button
          className={`skin-viewer3d-spin ${rotating ? 'skin-viewer3d-spin-active' : ''}`}
          onClick={() => setRotating((r) => !r)}
          title={rotating ? t('skin_viewer.pause_title') : t('skin_viewer.spin_title')}
        >
          <RotateCw size={14} />
          {rotating ? t('skin_viewer.pause') : t('skin_viewer.spin')}
        </button>
      </div>
      <p className="skin-viewer3d-hint">{t('skin_viewer.hint')}</p>
    </div>
  );
}

function project(p: Vec3, yaw: number, f: number, W: number, H: number) {
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const x = p[0] * cos + p[2] * sin;
  const z = -p[0] * sin + p[2] * cos;
  const y = p[1] - 16; // center the model vertically

  const y2 = y * Math.cos(CAM_PITCH) - z * Math.sin(CAM_PITCH);
  const z2 = y * Math.sin(CAM_PITCH) + z * Math.cos(CAM_PITCH);
  const zc = z2 + CAM_DIST;

  return {
    x: W / 2 + (f * x) / zc,
    y: H / 2 - (f * y2) / zc,
    z: zc,
  };
}

function render(canvas: HTMLCanvasElement | null, sim: SimState, width: number, height: number, capeSwing = 0) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const W = width;
  const H = height;
  const pxW = Math.round(W * dpr);
  const pxH = Math.round(H * dpr);
  if (canvas.width !== pxW || canvas.height !== pxH) {
    canvas.width = pxW;
    canvas.height = pxH;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const f = H / 2 / Math.tan(FOV / 2);
  const yaw = sim.yaw;

  // Ground shadow under the feet.
  const feet = project([0, 0, 0], yaw, f, W, H);
  ctx.save();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
  ctx.beginPath();
  ctx.ellipse(feet.x, feet.y + 2, (9.5 * f) / feet.z, (2.6 * f) / feet.z, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  if (!sim.ready) return;

  // Cape flutter: a small rotation around the cape's top edge (the hinge where
  // it attaches to the shoulders). Only the cape's own vertices are moved, so
  // the rest of the model stays rigid.
  const swing = capeSwing || 0;
  const cosS = Math.cos(swing);
  const sinS = Math.sin(swing);
  const swingPoint = (p: Vec3): Vec3 =>
    swing === 0
      ? p
      : (() => {
          const dy = p[1] - 24; // hinge line height
          const dz = p[2] + 3.5; // hinge depth (cape center)
          return [p[0], 24 + dy * cosS - dz * sinS, -3.5 + dy * sinS + dz * cosS];
        })();

  const projected: ProjectedFace[] = [];
  const projectFace = (face: Face3D, applySwing: boolean) => {
    const { nx, ny } = face;
    const pts = applySwing ? (face.pts.map(swingPoint) as [Vec3, Vec3, Vec3, Vec3]) : face.pts;
    const [p0, p1, p2, p3] = pts;
    const grid: Array<Array<{ x: number; y: number }>> = [];
    for (let j = 0; j <= ny; j++) {
      const v = j / ny;
      const row: Array<{ x: number; y: number }> = [];
      for (let i = 0; i <= nx; i++) {
        const u = i / nx;
        // Bilinear over the planar rectangle = exact interior point.
        const bx = p0[0] * (1 - u) * (1 - v) + p1[0] * u * (1 - v) + p2[0] * (1 - u) * v + p3[0] * u * v;
        const by = p0[1] * (1 - u) * (1 - v) + p1[1] * u * (1 - v) + p2[1] * (1 - u) * v + p3[1] * u * v;
        const bz = p0[2] * (1 - u) * (1 - v) + p1[2] * u * (1 - v) + p2[2] * (1 - u) * v + p3[2] * u * v;
        row.push(project([bx, by, bz], yaw, f, W, H));
      }
      grid.push(row);
    }
    const center = project(applySwing ? swingPoint(face.center) : face.center, yaw, f, W, H);
    projected.push({ face, grid, depth: center.z });
  };
  // Skin stays rigid; only the cape flutters.
  for (const face of sim.skinFaces) projectFace(face, false);
  for (const face of sim.capeFaces) projectFace(face, true);
  // Far faces first, so nearer faces draw on top (painter's algorithm).
  projected.sort((a, b) => b.depth - a.depth);

  ctx.imageSmoothingEnabled = false;
  for (const { face, grid } of projected) {
    drawFace(ctx, face, grid, dpr);
  }
  ctx.imageSmoothingEnabled = true;
}

function drawFace(
  ctx: CanvasRenderingContext2D,
  face: Face3D,
  grid: Array<Array<{ x: number; y: number }>>,
  dpr: number
) {
  const { nx, ny } = face;
  const cw = face.canvas.width;
  const ch = face.canvas.height;
  const sw = cw / nx;
  const sh = ch / ny;

  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const q0 = grid[j][i];
      const q1 = grid[j][i + 1];
      const q2 = grid[j + 1][i];
      // Affine map from this texture cell to its projected sub-quad. Neighbor
      // cells share projected vertices, so there are no seams; the ~2px cells
      // keep the affine error negligible (near-perspective-correct).
      const m11 = (q1.x - q0.x) / sw;
      const m12 = (q1.y - q0.y) / sw;
      const m21 = (q2.x - q0.x) / sh;
      const m22 = (q2.y - q0.y) / sh;
      ctx.setTransform(dpr * m11, dpr * m12, dpr * m21, dpr * m22, dpr * q0.x, dpr * q0.y);
      // 9-arg form: source rect (texture cell) -> destination rect (0,0,sw,sh)
      // under the affine transform. The 5-arg form would draw the whole face
      // image into the cell.
      ctx.drawImage(face.canvas, i * sw, j * sh, sw, sh, 0, 0, sw, sh);
    }
  }
}

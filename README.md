<p align="center">
  <img src="ico.ico.png" width="80" alt="SlimeLauncher" />
</p>

<h1 align="center">SlimeLauncher</h1>

<p align="center">
  <b>The cozy Minecraft launcher — fast, slime-themed, like TLauncher but better.</b><br>
  Launch any version from <code>c0.0.11</code> to <code>26.x</code> with mods in one click. No Java setup, no manual tuning.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-1.18.4-4ade80?style=flat-square" />
  <img src="https://img.shields.io/badge/platform-Windows-0078D6?style=flat-square" />
  <img src="https://img.shields.io/badge/electron-33-47848F?style=flat-square" />
  <img src="https://img.shields.io/badge/license-Proprietary-red?style=flat-square" />
</p>

<p align="center">
  <a href="#-quick-start">Quick Start</a> •
  <a href="#-features">Features</a> •
  <a href="#-skins--capes">Skins</a> •
  <a href="#-play-together">Play together</a> •
  <a href="#-troubleshooting">Troubleshooting</a> •
  <a href="DOCUMENTATION.md">Full Docs</a> •
  <a href="SKIN_CATALOG_GUIDE.md">Skin Catalog Guide</a> •
  <a href="CHANGELOG.md">Changelog</a>
</p>

---

### ✨ Why SlimeLauncher?

- **Zero-setup Java** — the correct runtime (`Java 8 → 25`) downloads automatically for every version, including Forge/NeoForge. First launch just works.
- **Auto-tuned performance** — RAM is picked for your machine out of the box and never exceeds what fits; broken downloads self-heal instead of crashing the game.
- **Offline + Microsoft** — up to 8 accounts, instant switching. CaSe matters (`Sigmultra452 ≠ sigmultra452`): use the exact nickname your server expects.
- **Any version** — vanilla, Fabric, Forge, NeoForge, Quilt, snapshots, betas, alphas — with automatic loader installation.
- **Mods / Maps / Modpacks** — 1-click install from Modrinth & CurseForge, `Update all` for mods, screenshot galleries.
- **Skins & Capes like TLauncher** — offline skins, HD skins, capes, plus automatic pull from `ely.by`. See [Skins & Capes](#-skins--capes).
- **Friends on LAN** — see who is `In menu / LAN world` on the same Wi-Fi and join in one click.
- **Network** — play over the internet without port-forward or Hamachi/Radmin (built-in, like a VPN inside the launcher).
- **Own server** — `Paper/Vanilla` dedicated server in 1 click, with UPnP port-forwarding and live console.
- **Safety nets** — automatic world backups before every launch, game console with crash reports, per-version native handling.

### 🚀 Quick Start

**1. Download**
Get `SlimeLauncher Setup 1.18.4.exe` from [**Releases**](https://github.com/Mishaadevv/SlimeLauncher/releases) → run → pick folder. (Portable `SlimeLauncher 1.18.4.exe` needs no install.)

**2. Create account**
`Accounts` → `Add offline` → nickname with **exact CaSe** that your server expects. Or `Link Microsoft account` (needs owned Java Edition) — skins and settings carry over.

**3. Create instance**
`Instances` → `Create Instance` → pick version (e.g. `1.21.1`) + loader (`Fabric` for mods) → `Play`. Java and RAM are handled automatically.

**4. Install mods**
`Mods` → choose your instance → search `sodium`, `jei` → `Install`. Loader instances only (vanilla can't run mods).

### 🎨 Skins & Capes

**Quick (between SlimeLauncher users):** `Skins` → upload skin (`PNG 64×64…1024×1024`, slim/classic) and optional cape (`64×32…1024×512`). Works out of the box on LAN, `Open to LAN` worlds and Network sessions.

**Any cracked server (TLauncher-style):** register at **[ely.by](https://ely.by)** with **the same nickname (CaSe!)** → upload skin/cape there → the launcher pulls it automatically. No setup needed.

**Your own community:** deploy the shared skin directory (`server/` → Render/Fly.io, see [`SKIN_CATALOG_GUIDE.md`](SKIN_CATALOG_GUIDE.md)) and put the URL in `Settings → Advanced` — then everyone with the launcher sees each other on any server.

> Note: on someone else's public server, strangers' skins can't be resolved by any client-side launcher (there is no global nick→skin map) — that's a protocol limit, not a bug. Everything above covers all cases that are technically possible.

### 🤝 Play together

- **Same Wi-Fi:** one player opens their world `Open to LAN`, others join via `Multiplayer` (or the `Friends` tab, which shows live status).
- **Different cities:** `Network` → `Create Network` → share the key → friend `Join Network` → host opens LAN world → it appears in `Multiplayer` as if you were next to each other.
- **Own public server:** `Instances` → `Servers` → create `Paper/Vanilla` → `Start` → share your IP (enable UPnP or forward port `25565`).

### ⚙️ Notable settings

- `Settings → Minecraft` — Java path (`Auto-detect` by default), RAM (auto-tuned, shows the recommendation for your machine), JVM flags, game console, Discord Rich Presence.
- `Settings → World backups` — auto-backup before launch, how many to keep, where.
- `Settings → Advanced` — skin directory URL, logs folder, dev mode.

### 📦 Build from source

Requirements: `Node.js 20+`, Windows 10/11 64-bit.

```bash
npm install
npm run build
npx electron-builder --win --publish never
# → release/SlimeLauncher Setup 1.18.4.exe + portable SlimeLauncher 1.18.4.exe
```

Useful scripts: `npm run dev` (dev mode), `npm run typecheck`, `npm run lint`, `npm run bump` (version from `CHANGELOG.md`).

### 🛠 Troubleshooting

- **"Automatic Java download failed"** — check internet (`api.adoptium.net` must open), ~300 MB free space, antivirus quarantine; then press Play again. Or install Java manually and pick it in `Settings → Minecraft`.
- **Everyone is Steve** — re-read [Skins & Capes](#-skins--capes): on LAN/Network update both sides to the latest version; on public servers use ely.by (yourself) or a shared directory (everyone).
- **"Invalid session" on a licensed server** — `Accounts` → remove and re-link the Microsoft account.
- **Friends not visible on LAN** — same Wi-Fi (not guest network), allow SlimeLauncher in Windows Firewall on both PCs, no VPN rerouting traffic.
- **Something else** — `Settings → Open logs folder` → send `main.log` with your report.

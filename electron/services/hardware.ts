import os from 'node:os';

// Hardware probing used to pick sane defaults automatically (no buttons):
// a fresh install on an 8 GB laptop should not default to the same RAM as a
// 32 GB desktop, and a stale 8 GB setting must never be handed to the JVM on
// a 4 GB machine ("Could not reserve enough space").

export interface HardwareInfo {
  totalMemMB: number;
  freeMemMB: number;
  cpuCount: number;
  cpuModel: string;
  platform: string;
  arch: string;
  recommendedRamMB: number;
}

// Picks the default Minecraft heap for a machine. Vanilla is happy with
// 2–3 GB, modpacks want more; always leave at least 1 GB for the OS.
export function recommendedRamMB(totalMemMB: number): number {
  let tier: number;
  if (totalMemMB >= 32768) tier = 8192;
  else if (totalMemMB >= 16384) tier = 4096;
  else if (totalMemMB >= 8192) tier = 3072;
  else tier = 2048;
  return Math.max(1024, Math.min(tier, totalMemMB - 1024));
}

export function getHardwareInfo(): HardwareInfo {
  const totalMemMB = Math.floor(os.totalmem() / 1024 / 1024);
  const cpus = os.cpus();
  return {
    totalMemMB,
    freeMemMB: Math.floor(os.freemem() / 1024 / 1024),
    cpuCount: cpus.length,
    cpuModel: (cpus[0]?.model || 'Unknown CPU').trim(),
    platform: process.platform,
    arch: process.arch,
    recommendedRamMB: recommendedRamMB(totalMemMB),
  };
}

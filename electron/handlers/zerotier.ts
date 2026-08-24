import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc.js';
import type { HandlerDeps } from './types.js';
import { notify } from './types.js';
import { isZeroTierInstalled, isZeroTierConnected, isRadminVpnRunning, installZeroTier } from '../services/zerotier.js';

let _installing = false;

export function registerZeroTierHandlers(deps: HandlerDeps) {
  const { logger } = deps;

  ipcMain.handle(IPC.ZT_STATUS, async () => {
    const [installed, connected, radminRunning] = await Promise.all([
      isZeroTierInstalled(),
      isZeroTierConnected(),
      isRadminVpnRunning(),
    ]);
    return { installed, connected, radminRunning, installing: _installing };
  });

  ipcMain.handle(IPC.ZT_INSTALL, async () => {
    if (_installing) return { ok: false, error: 'Already installing.' };
    _installing = true;
    try {
      // Progress toasts are throttled to one per phase change (or at most
      // once every 5 seconds) with a short lifetime, so an install never
      // floods the notification stack.
      let lastPhase = '';
      let lastToast = 0;
      const res = await installZeroTier(logger, (_pct, label) => {
        const now = Date.now();
        if (label === lastPhase && now - lastToast < 5000) return;
        lastPhase = label;
        lastToast = now;
        notify(deps, { type: 'info', title: 'ZeroTier VPN', message: label, duration: 8000 });
      });
      return res;
    } finally {
      _installing = false;
    }
  });
}
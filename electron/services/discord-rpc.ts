import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Logger } from './logger.js';

// Discord Rich Presence over Discord's local IPC pipe — zero dependencies.
//
// Protocol (discord-ipc): frames of [u32 LE opcode][u32 LE length][JSON].
//   op 0 HANDSHAKE  {"v":1,"client_id":"<app id>"}
//   op 1 FRAME      {cmd:"SET_ACTIVITY", args:{pid, activity}, nonce}
//   op 3 PING       {} — heartbeat every ~15 s keeps the connection alive.
//
// The client_id must be a real Discord application id (discord.com/developers
// → New Application → Application ID). Without it Rich Presence cannot work,
// so the service stays idle until the user configures one in Settings.

const OPCODES = {
  HANDSHAKE: 0,
  FRAME: 1,
  CLOSE: 2,
  PING: 3,
} as const;

export interface DiscordActivity {
  details: string;
  state?: string;
  startTimestamp?: number;
  largeImageKey?: string;
  largeImageText?: string;
}

interface Pending {
  resolve: () => void;
  timer: NodeJS.Timeout;
}

function pipeCandidates(): string[] {
  if (process.platform === 'win32') {
    return [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => `\\\\?\\pipe\\discord-ipc-${i}`);
  }
  const tmp = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || os.tmpdir();
  return [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => path.join(tmp, `discord-ipc-${i}`));
}

export class DiscordRpcService {
  private logger: Logger;
  private clientId = '';
  private enabled = false;
  private socket: net.Socket | null = null;
  private connecting = false;
  private connected = false;
  private buffer: Buffer = Buffer.alloc(0);
  private latest: DiscordActivity | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pending = new Map<string, Pending>();

  constructor(logger: Logger) {
    this.logger = logger;
  }

  configure(enabled: boolean, clientId: string) {
    const id = String(clientId || '').trim();
    this.enabled = !!enabled && /^\d{15,25}$/.test(id);
    this.clientId = id;
    if (!this.enabled || !id) {
      this.latest = null;
      this.disconnect();
      return;
    }
    // Reconnect with the new id if we were already up.
    if (this.connected && this.socket) {
      this.disconnect();
    }
    void this.ensureConnected();
  }

  setActivity(activity: DiscordActivity | null) {
    this.latest = activity;
    if (!activity) {
      this.sendFrame(OPCODES.FRAME, {
        cmd: 'SET_ACTIVITY',
        args: { pid: process.pid, activity: null },
        nonce: randomUUID(),
      }).catch(() => {});
      return;
    }
    void this.ensureConnected().then(() => {
      if (!this.connected) return;
      const payload: Record<string, unknown> = {
        cmd: 'SET_ACTIVITY',
        args: {
          pid: process.pid,
          activity: {
            details: activity.details,
            ...(activity.state ? { state: activity.state } : {}),
            ...(activity.startTimestamp ? { timestamps: { start: activity.startTimestamp } } : {}),
            instance: true,
          },
        },
        nonce: randomUUID(),
      };
      this.sendFrame(OPCODES.FRAME, payload).catch(() => {});
    });
  }

  dispose() {
    this.enabled = false;
    this.latest = null;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.disconnect();
  }

  private disconnect() {
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.resolve(); }
    this.pending.clear();
    if (this.socket) {
      try { this.socket.destroy(); } catch { /* ignore */ }
      this.socket = null;
    }
    this.connected = false;
    this.buffer = Buffer.alloc(0);
  }

  private scheduleReconnect(delayMs = 15000) {
    if (!this.enabled || this.reconnectTimer || !this.latest) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.ensureConnected().then(() => {
        if (this.latest) this.setActivity(this.latest);
      });
    }, delayMs);
  }

  private async ensureConnected(): Promise<void> {
    if (!this.enabled || !this.clientId || this.connected || this.connecting) return;
    this.connecting = true;
    for (const pipePath of pipeCandidates()) {
      try {
        await this.tryConnect(pipePath);
        this.connecting = false;
        this.logger.info('Discord RPC connected', { pipe: pipePath });
        return;
      } catch {
        /* try next pipe */
      }
    }
    this.connecting = false;
    this.scheduleReconnect();
  }

  private tryConnect(pipePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(pipePath);
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        socket.setTimeout(0);
        if (ok) resolve();
        else {
          try { socket.destroy(); } catch { /* ignore */ }
          reject(new Error('pipe failed'));
        }
      };
      socket.setTimeout(3000, () => done(false));
      socket.once('connect', () => {
        this.socket = socket;
        this.buffer = Buffer.alloc(0);
        this.bindSocket(socket);
        // Handshake
        this.write(socket, OPCODES.HANDSHAKE, JSON.stringify({ v: 1, client_id: this.clientId }));
        // Consider it up after the handshake frame is written; Discord replies
        // with a DISPATCH frame which bindSocket consumes silently.
        setTimeout(() => done(this.socket === socket), 250);
      });
      socket.once('error', () => done(false));
    });
  }

  private bindSocket(socket: net.Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length >= 8) {
        const len = this.buffer.readUInt32LE(4);
        if (this.buffer.length < 8 + len) break;
        const op = this.buffer.readUInt32LE(0);
        const body = this.buffer.subarray(8, 8 + len).toString('utf8');
        this.buffer = this.buffer.subarray(8 + len);
        try {
          const msg = JSON.parse(body) as { nonce?: string; evt?: string };
          if (msg.nonce && this.pending.has(msg.nonce)) {
            const p = this.pending.get(msg.nonce)!;
            clearTimeout(p.timer);
            this.pending.delete(msg.nonce);
            p.resolve();
          }
          if (op === OPCODES.CLOSE) {
            this.disconnect();
            this.scheduleReconnect();
          }
        } catch { /* malformed frame — ignore */ }
      }
    });
    socket.on('close', () => {
      if (this.socket === socket) {
        this.disconnect();
        this.scheduleReconnect(5000);
      }
    });
    socket.on('error', () => { /* handled via close */ });

    // Heartbeat keeps Discord from dropping the connection.
    this.heartbeat = setInterval(() => {
      if (this.socket !== socket || socket.destroyed) return;
      this.write(socket, OPCODES.PING, '{}');
    }, 15000);
  }

  private write(socket: net.Socket, op: number, json: string) {
    const payload = Buffer.from(json, 'utf8');
    const header = Buffer.alloc(8);
    header.writeUInt32LE(op, 0);
    header.writeUInt32LE(payload.length, 4);
    socket.write(Buffer.concat([header, payload]));
  }

  private sendFrame(op: number, obj: unknown): Promise<void> {
    const socket = this.socket;
    if (!socket || !this.connected) return Promise.resolve();
    const nonce = (obj as { nonce?: string }).nonce || '';
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (nonce) this.pending.delete(nonce);
        resolve();
      }, 4000);
      if (nonce) this.pending.set(nonce, { resolve, timer });
      else {
        clearTimeout(timer);
        resolve();
      }
      this.write(socket, op, JSON.stringify(obj));
    });
  }
}

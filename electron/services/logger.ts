import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

// Lightweight rotating logger. Writes to userData/logs/slimelauncher.log
// and mirrors to console. Never blocks the UI thread (sync fs is fine for
// small append writes on the main process).
export class Logger {
  private logDir: string | null = null;
  private logFile: string | null = null;
  private maxBytes = 2 * 1024 * 1024; // 2 MB rotation
  // The game streams thousands of log lines through here; stat-ing the file on
  // every line is measurable main-process overhead. Only re-check rotation
  // after ~256 KB of new output.
  private bytesSinceRotateCheck = 0;

  constructor() {
    // Paths are resolved lazily on first write — `app.getPath('userData')`
    // is only available after `app.whenReady()`, but Logger is instantiated
    // at module load time (before the app is ready).
  }

  private resolvePaths() {
    if (this.logDir && this.logFile) return;
    this.logDir = path.join(app.getPath('userData'), 'logs');
    this.logFile = path.join(this.logDir, 'slimelauncher.log');
  }

  private ensureDir() {
    this.resolvePaths();
    if (!this.logDir) return;
    if (!fs.existsSync(this.logDir)) fs.mkdirSync(this.logDir, { recursive: true });
  }

  private rotateIfNeeded(incomingBytes: number) {
    this.bytesSinceRotateCheck += incomingBytes;
    if (this.bytesSinceRotateCheck < 256 * 1024) return;
    this.bytesSinceRotateCheck = 0;
    if (!this.logFile) return;
    try {
      if (fs.existsSync(this.logFile) && fs.statSync(this.logFile).size > this.maxBytes) {
        const backup = this.logFile.replace('.log', '.1.log');
        if (fs.existsSync(backup)) fs.unlinkSync(backup);
        fs.renameSync(this.logFile, backup);
      }
    } catch {
      // ignore rotation errors
    }
  }

  private write(level: string, msg: string, extra?: unknown) {
    this.ensureDir();
    const ts = new Date().toISOString();
    const line = extra ? `[${ts}] ${level} ${msg} ${JSON.stringify(extra)}` : `[${ts}] ${level} ${msg}`;
    console.log(line);
    try {
      if (this.logFile) {
        this.rotateIfNeeded(Buffer.byteLength(line) + 1);
        fs.appendFileSync(this.logFile, line + '\n');
      }
    } catch {
      // best effort
    }
  }

  info(msg: string, extra?: unknown) { this.write('INFO', msg, extra); }
  warn(msg: string, extra?: unknown) { this.write('WARN', msg, extra); }
  error(msg: string, extra?: unknown) { this.write('ERROR', msg, extra); }
  debug(msg: string, extra?: unknown) { if (process.env.NODE_ENV === 'development') this.write('DEBUG', msg, extra); }
}

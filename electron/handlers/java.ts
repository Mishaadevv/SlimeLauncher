import { ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { app } from 'electron';
import { IPC } from '../../shared/ipc.js';
import type { HandlerDeps } from './types.js';

const execFileAsync = promisify(execFile);

interface JavaInstall {
  path: string;
  version: string;
}

async function probeJava(javaPath: string): Promise<JavaInstall | null> {
  try {
    const { stdout, stderr } = await execFileAsync(javaPath, ['-version'], { timeout: 5000 });
    // `java -version` prints to stderr (and occasionally stdout) — check both.
    const output = `${stdout}\n${stderr}`;
    const match = output.match(/version "([^"]+)"/);
    const version = match ? match[1] : 'unknown';
    return { path: javaPath, version };
  } catch {
    return null;
  }
}

export function registerJavaHandlers(deps: HandlerDeps) {
  const { logger } = deps;

  const detect = async (): Promise<JavaInstall[]> => {
    const candidates: string[] = [];
    const home = process.env.USERPROFILE || process.env.HOME || '';

    if (process.platform === 'win32') {
      const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
      const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

      // JAVA_HOME env var
      const javaHome = process.env.JAVA_HOME;
      if (javaHome) {
        candidates.push(path.join(javaHome, 'bin', 'java.exe'));
      }

      const javaDir = path.join(programFiles, 'Java');
      if (fs.existsSync(javaDir)) {
        for (const d of fs.readdirSync(javaDir)) {
          candidates.push(path.join(javaDir, d, 'bin', 'java.exe'));
        }
      }
      const javaDirX86 = path.join(programFilesX86, 'Java');
      if (fs.existsSync(javaDirX86)) {
        for (const d of fs.readdirSync(javaDirX86)) {
          candidates.push(path.join(javaDirX86, d, 'bin', 'java.exe'));
        }
      }
      // Eclipse Adoptium / Temurin
      const adoptiumDir = path.join(programFiles, 'Eclipse Adoptium');
      if (fs.existsSync(adoptiumDir)) {
        for (const d of fs.readdirSync(adoptiumDir)) {
          candidates.push(path.join(adoptiumDir, d, 'bin', 'java.exe'));
        }
      }
      // Microsoft OpenJDK
      const msDir = path.join(programFiles, 'Microsoft');
      if (fs.existsSync(msDir)) {
        for (const d of fs.readdirSync(msDir)) {
          if (d.toLowerCase().includes('jdk') || d.toLowerCase().includes('java')) {
            candidates.push(path.join(msDir, d, 'bin', 'java.exe'));
          }
        }
      }
      // Zulu / Azul
      const zuluDir = path.join(programFiles, 'Zulu');
      if (fs.existsSync(zuluDir)) {
        for (const d of fs.readdirSync(zuluDir)) {
          candidates.push(path.join(zuluDir, d, 'bin', 'java.exe'));
        }
      }
      // Common launcher/runtime locations
      const mcRuntime = path.join(home, '.minecraft', 'runtime');
      if (fs.existsSync(mcRuntime)) {
        walkForJava(mcRuntime, candidates, 'java.exe');
      }
      // .slimelauncher runtime
      const slRuntime = path.join(home, '.slimelauncher', 'runtime');
      if (fs.existsSync(slRuntime)) {
        for (const d of fs.readdirSync(slRuntime)) {
          if (d.startsWith('jdk')) {
            candidates.push(path.join(slRuntime, d, 'bin', 'java.exe'));
          } else {
            walkForJava(path.join(slRuntime, d), candidates, 'java.exe');
          }
        }
      }
      // JetBrains / IntelliJ runtimes
      const jetbrainsDir = path.join(home, '.jdks');
      if (fs.existsSync(jetbrainsDir)) {
        for (const d of fs.readdirSync(jetbrainsDir)) {
          candidates.push(path.join(jetbrainsDir, d, 'bin', 'java.exe'));
        }
      }
    } else {
      candidates.push('/usr/bin/java', '/usr/local/bin/java');
      const javaHome = process.env.JAVA_HOME;
      if (javaHome) {
        candidates.push(path.join(javaHome, 'bin', 'java'));
      }
      const sdkman = path.join(home, '.sdkman', 'candidates', 'java');
      if (fs.existsSync(sdkman)) {
        for (const d of fs.readdirSync(sdkman)) {
          candidates.push(path.join(sdkman, d, 'bin', 'java'));
        }
      }
    }

    const found: JavaInstall[] = [];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        const info = await probeJava(c);
        if (info) found.push(info);
      }
    }
    // Also try PATH java
    const pathJava = await probeJava('java');
    if (pathJava && !found.some((f) => f.path === pathJava.path)) found.push(pathJava);

    return found;
  };

  ipcMain.handle(IPC.JAVA_DETECT, async () => {
    const found = await detect();
    logger.info('Java detection complete', { count: found.length });
    return found;
  });

  ipcMain.handle(IPC.JAVA_LIST, async () => {
    const found = await detect();
    logger.info('Java list complete', { count: found.length });
    return found;
  });
}

function walkForJava(dir: string, out: string[], exeName: string, depth = 0) {
  if (depth > 4) return;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === exeName) {
        out.push(path.join(dir, entry.name));
        return;
      }
      if (entry.isDirectory()) {
        walkForJava(path.join(dir, entry.name), out, exeName, depth + 1);
      }
    }
  } catch {
    // ignore permission errors
  }
}

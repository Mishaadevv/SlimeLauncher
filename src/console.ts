// Minecraft console window: streams the game's stdout/stderr live while it
// runs, and shows the captured log on crash. Runs standalone (no React) — it
// fetches the current console state from main on load, then appends live
// chunks and status updates pushed over IPC.

import './console.css';

interface ConsoleState {
  session: number;
  title: string;
  instanceName: string;
  output: string;
  status: 'starting' | 'running' | 'crashed' | 'closed';
  exitCode: number | null;
  crashedAt: number | null;
  logPath: string | null;
}

const outputEl = document.getElementById('console-output') as HTMLPreElement;
const titleEl = document.getElementById('console-title') as HTMLDivElement;
const metaEl = document.getElementById('console-meta') as HTMLDivElement;
const footerEl = document.getElementById('console-footer') as HTMLElement;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Lightweight ANSI → HTML for the most common codes Java/Minecraft emit.
// Anything unknown is stripped so the log stays readable.
function renderAnsi(line: string): string {
  const esc = escapeHtml(line);
  return esc.replace(
    // ANSI escape sequences are exactly what this function exists to parse.
    // eslint-disable-next-line no-control-regex
    /\x1b\[([0-9;]*)m/g,
    (_, codes: string) => {
      const parts = codes.split(';').map((c: string) => Number(c) || 0);
      const classes: string[] = [];
      for (const p of parts) {
        if (p === 0) classes.length = 0;
        else if (p >= 30 && p <= 37) classes.length = 0; // reset color to default
        else if (p === 31 || p === 91) classes.push('err');
        else if (p === 33 || p === 93) classes.push('warn');
      }
      return classes.length ? `<span class="${classes.join(' ')}">` : '</span>';
    }
  );
}

function renderAnsiLines(chunk: string): string {
  const lines = chunk.split(/\r?\n/);
  return lines.map((l, i) => {
    const h = renderAnsi(l);
    return i < lines.length - 1 ? (h || '&nbsp;') + '\n' : h;
  }).join('');
}

// --- Live streaming ---
let session = -1;
let pending = '';
let raf: number | null = null;

function autoScroll() {
  const nearBottom = outputEl.scrollHeight - outputEl.scrollTop - outputEl.clientHeight < 80;
  if (nearBottom) outputEl.scrollTop = outputEl.scrollHeight;
}

function flush() {
  raf = null;
  if (!pending) return;
  const html = renderAnsiLines(pending);
  pending = '';
  outputEl.insertAdjacentHTML('beforeend', html);
  autoScroll();
}

function scheduleFlush() {
  if (raf !== null) return;
  raf = requestAnimationFrame(flush);
}

function applyStatus(state: Pick<ConsoleState, 'status' | 'exitCode'>) {
  if (state.status === 'crashed') {
    metaEl.textContent = state.exitCode === null
      ? 'Minecraft failed to start'
      : `Minecraft exited with code ${state.exitCode}`;
  } else if (state.status === 'closed') {
    metaEl.textContent = `Minecraft exited with code ${state.exitCode}`;
  } else {
    metaEl.textContent = 'Minecraft is running…';
  }
}

function render(state: ConsoleState) {
  session = state.session;
  titleEl.textContent = state.title || 'Minecraft Console';
  applyStatus(state);
  const lines = (state.output || '').split(/\r?\n/);
  outputEl.innerHTML = lines.map((l) => renderAnsi(l) || '&nbsp;').join('\n');
  outputEl.scrollTop = outputEl.scrollHeight;
  const foot = state.instanceName ? `Instance: ${state.instanceName}` : '';
  const log = state.logPath ? ` · Log: ${state.logPath}` : '';
  footerEl.textContent = `${foot}${log}`;
}

// Register listeners BEFORE fetching the initial state so no live chunk is
// missed while the page loads.
window.slime.mc.onConsoleLive((e) => {
  if (e.session !== session) return;
  pending += e.chunk;
  scheduleFlush();
});

window.slime.mc.onConsoleStatus((e) => {
  if (e.session !== session) return;
  if (e.title) titleEl.textContent = e.title;
  applyStatus({ status: e.status as ConsoleState['status'], exitCode: e.exitCode });
});

async function init() {
  try {
    const data = (await window.slime.mc.getConsoleData()) as { session: number; state: ConsoleState } | null;
    if (data?.state) {
      render(data.state);
    } else {
      metaEl.textContent = 'Waiting for Minecraft to start…';
      outputEl.textContent = 'The game has not produced any output yet.';
    }
  } catch (e) {
    metaEl.textContent = 'Failed to read console data.';
    outputEl.textContent = String(e);
  }
}

document.getElementById('console-copy')?.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(outputEl.textContent || '');
    const btn = document.getElementById('console-copy');
    if (btn) btn.textContent = 'Copied!';
    setTimeout(() => { if (btn) btn.textContent = 'Copy'; }, 1200);
  } catch { /* clipboard unavailable */ }
});

document.getElementById('console-close')?.addEventListener('click', () => window.close());

void init();

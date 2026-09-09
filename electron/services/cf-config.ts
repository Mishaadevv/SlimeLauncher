// Central CurseForge configuration.
//
// The CurseForge API key is read from the SLIME_CF_API_KEY environment
// variable so it can be replaced without rebuilding. A built-in default keeps
// the public CurseForge features (mod/map search and screenshots) working for
// stock installs; forks / public releases should export their own key via the
// environment instead of shipping this one.
//
// The key must only ever be sent to api.curseforge.com and the forgecdn.net
// image CDNs — main.ts enforces that with a host allow-list (isForgeCdnHost),
// so the cfimg:// handler can never leak it to an arbitrary third party.

const DEFAULT_CF_KEY = '$2a$10$bL4bIL5pUWqfcO7KQtnMReakwtfHbNKh6v1uTpKlzhwoueEjQnPnm';

export function cfApiKey(): string {
  return (process.env.SLIME_CF_API_KEY || DEFAULT_CF_KEY).trim();
}

export const CF_API = 'https://api.curseforge.com';

// Image hosts that CurseForge serves mod/map artwork and screenshots from
// (edge.forgecdn.net -> mediafilez.forgecdn.net redirects).
export function isForgeCdnHost(hostname: string): boolean {
  const h = String(hostname || '').toLowerCase();
  return h === 'forgecdn.net' || h.endsWith('.forgecdn.net');
}

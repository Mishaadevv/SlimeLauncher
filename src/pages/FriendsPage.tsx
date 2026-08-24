import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Users, UserPlus, Copy, Check, X, Wifi, WifiOff, Signal, Globe, MapPin, Gamepad2 } from 'lucide-react';
import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { useNotificationStore } from '@/store/notification-store';
import { t } from '@/lib/i18n';
import type { FriendRow, FriendPresence, PresenceSnapshot, SelfPresence } from '@shared/types';
import './FriendsPage.css';

function isOnline(p: FriendPresence | undefined): p is FriendPresence {
  return !!p && Date.now() - p.lastSeen < 15000;
}

function loaderLabel(loader: string | null | undefined): string {
  if (!loader || loader === 'vanilla') return '';
  return ` (${loader})`;
}

function statusOf(p: FriendPresence | undefined): { label: string; cls: 'on' | 'off' } {
  if (!isOnline(p)) return { label: t('friends.offline'), cls: 'off' };
  const base = `${p.game || ''}${loaderLabel(p.loader)}`;
  switch (p.state) {
    case 'lan':
      return { label: `${t('friends.online_lan', { port: String(p.port ?? '?') })}${base ? ` — ${base}` : ''}`, cls: 'on' };
    case 'server':
      return { label: `${t('friends.online_server', { server: p.server || '?' })}${base ? ` — ${base}` : ''}`, cls: 'on' };
    case 'menu':
      return { label: `${t('friends.online_menu')}${base ? ` — ${base}` : ''}`, cls: 'on' };
    default:
      return { label: t('friends.online_launcher'), cls: 'on' };
  }
}

function selfStatus(s: SelfPresence | null): string {
  if (!s) return t('friends.setting_up');
  const base = `${s.game || ''}${loaderLabel(s.loader)}`;
  const ips = s.ips && s.ips.length > 0 ? ` · ${s.ips.join(', ')}` : '';
  switch (s.state) {
    case 'lan': return `${t('friends.you_playing')} — LAN world on port ${s.port ?? '?'}${base ? ` (${base})` : ''}${ips}`;
    case 'server': return `${t('friends.you_playing')} — on ${s.server || 'server'}${base ? ` (${base})` : ''}${ips}`;
    case 'menu': return `${t('friends.you_playing')} — in game${base ? ` (${base})` : ''}${ips}`;
    default: return `${t('friends.you_launcher')}${ips}`;
  }
}

function SkinHead({ uuid, port, skin, size = 40 }: { uuid: string; port: number | null; skin?: string | null; size?: number }) {
  const [failed, setFailed] = useState(false);
  // Prefer the friend's own skin, broadcast by their launcher in the presence
  // packet — our local skin server has no entry for it. Fall back to the local
  // skin server (which now resolves premium players' real skins via Mojang).
  const src = skin
    ? `data:image/png;base64,${skin}`
    : port
      ? `http://127.0.0.1:${port}/textures/${uuid}`
      : null;
  if (failed || !src) {
    return (
      <div className="friend-head friend-head-default" style={{ width: size, height: size }}>
        <svg viewBox="0 0 8 8" width={size * 0.625} height={size * 0.625} aria-hidden>
          <rect x="1" y="0" width="6" height="4" fill="#6a9e52" />
          <rect x="2" y="1" width="1.5" height="1.5" fill="#8fbc6a" />
          <rect x="4.5" y="1" width="1.5" height="1.5" fill="#8fbc6a" />
          <rect x="0" y="4" width="8" height="4" fill="#3e6b34" />
        </svg>
      </div>
    );
  }
  return (
    <div
      className="friend-head"
      style={{
        width: size,
        height: size,
        backgroundImage: `url(${src})`,
        backgroundSize: size * 8,
        backgroundPosition: '0 0',
        imageRendering: 'pixelated',
      }}
      onErrorCapture={() => setFailed(true)}
      role="img"
    >
      <img src={src} alt="" style={{ display: 'none' }} onError={() => setFailed(true)} />
    </div>
  );
}

export function FriendsPage() {
  const { add } = useNotificationStore();
  const [friends, setFriends] = useState<FriendRow[]>([]);
  const [presence, setPresence] = useState<PresenceSnapshot | null>(null);
  const [skinPort, setSkinPort] = useState<number | null>(null);
  const [nick, setNick] = useState('');
  const [adding, setAdding] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [compat, setCompat] = useState<Record<string, { id: string; name: string; loader: string }[]>>({});

  const load = useCallback(async () => {
    try {
      const list = (await window.slime.friends.list()) as FriendRow[];
      setFriends(list);
    } catch {
      /* ignore */
    }
    try {
      const port = (await window.slime.skin.port()) as number;
      setSkinPort(port || null);
    } catch {
      setSkinPort(null);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!window.slime?.friends?.onPresence) return;
    const unsub = window.slime.friends.onPresence((snap) => setPresence(snap));
    return () => { unsub?.(); };
  }, []);

  // For every online friend playing on a LAN world, ask the main process which
  // of our instances could join (same MC version + identical mods).
  const lanFriends = useMemo(() => {
    if (!presence) return [];
    return presence.friends.filter((f) => isOnline(f) && f.state === 'lan');
  }, [presence]);

  const lastCompatKey = useRef<string | null>(null);
  useEffect(() => {
    const key = lanFriends.map((f) => `${f.nick}:${f.port}:${f.mods}`).join('|');
    if (key === lastCompatKey.current) return;
    lastCompatKey.current = key;
    if (lanFriends.length === 0) { setCompat({}); return; }
    for (const f of lanFriends) {
      window.slime.friends.compat(f.game || '', f.mods || '').then((res) => {
        setCompat((prev) => ({ ...prev, [f.nick.toLowerCase()]: (res as { id: string; name: string; loader: string }[]) || [] }));
      });
    }
  }, [lanFriends]);

  const handleAdd = async () => {
    const clean = nick.trim();
    if (!clean) return;
    setAdding(true);
    try {
      const res = await window.slime.friends.add(clean);
      if (res.ok) {
        setFriends((prev) => [res.friend as FriendRow, ...prev]);
        setNick('');
        add({ type: 'success', title: t('friends.added_title'), message: `${clean} ${t('friends.added')}`, duration: 3000 });
      } else {
        add({ type: 'error', title: t('friends.add_error_title'), message: String(res.error), duration: 4000 });
      }
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (f: FriendRow) => {
    await window.slime.friends.remove(f.id);
    setFriends((prev) => prev.filter((x) => x.id !== f.id));
    add({ type: 'info', title: t('friends.remove_title'), message: `${f.nick} ${t('friends.removed')}`, duration: 3000 });
  };

  const copyAddress = async (f: FriendRow, p: FriendPresence) => {
    const addr = `${p.ip}:${p.port}`;
    try {
      await navigator.clipboard.writeText(addr);
      setCopied(addr);
      setTimeout(() => setCopied((c) => (c === addr ? null : c)), 2000);
    } catch {
      add({ type: 'error', title: t('friends.copy_error_title'), message: t('friends.copy_failed'), duration: 3000 });
    }
  };

  const presenceByNick = useMemo(() => {
    const map = new Map<string, FriendPresence>();
    if (presence) for (const f of presence.friends) map.set(f.nick.toLowerCase(), f);
    return map;
  }, [presence]);

  return (
    <div className="friends-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('friends.title')}</h1>
          <p className="page-subtitle">{t('friends.subtitle')}</p>
        </div>
        <div className="page-header-actions">
          <div className={`friend-self-chip ${presence?.self && presence.self.state !== 'idle' ? 'friend-self-playing' : ''}`}>
            <span className="friend-self-dot" />
            {selfStatus(presence?.self ?? null)}
          </div>
        </div>
      </div>

      <div className="friend-add card">
        <div className="friend-add-icon"><UserPlus size={18} /></div>
        <input
          className="input"
          placeholder={t('friends.add_placeholder')}
          value={nick}
          maxLength={32}
          onChange={(e) => setNick(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void handleAdd(); }}
        />
        <Button variant="primary" size="sm" disabled={adding || !nick.trim()} onClick={() => void handleAdd()}>
          {adding ? t('friends.adding') : t('friends.add')}
        </Button>
      </div>

      <p className="friend-hint">
        {t('friends.hint')}
      </p>

      {friends.length > 0 && presence && !presence.friends.some((f) => isOnline(f)) && (
        <p className="friend-hint friend-hint-warn">
          {t('friends.offline_hint')}
        </p>
      )}

      <div className="friend-list">
        {friends.length === 0 ? (
          <EmptyState
            icon={<Users size={44} />}
            title={t('friends.empty_title')}
            description={t('friends.empty_desc')}
          />
        ) : (
          friends.map((f) => {
            const p = presenceByNick.get(f.nick.toLowerCase());
            const online = isOnline(p);
            const st = statusOf(p);
            const uuid = p?.uuid || f.uuid;
            const isLan = online && p?.state === 'lan';
            const matches = isLan ? compat[f.nick.toLowerCase()] : undefined;
            const address = isLan && p ? `${p.ip}:${p.port}` : null;
            return (
              <div className={`friend-card card ${online ? 'friend-card-online' : ''}`} key={f.id}>
                <SkinHead uuid={uuid} port={skinPort} skin={p?.skin} size={44} />
                <div className="friend-main">
                  <div className="friend-name-row">
                    <span className="friend-name">{f.nick}</span>
                    <span className={`friend-status friend-status-${st.cls}`}>
                      {online ? <Wifi size={12} /> : <WifiOff size={12} />}
                      {st.label}
                    </span>
                  </div>
                  {isLan && p && (
                    <div className="friend-lan">
                      <span className="friend-lan-title"><MapPin size={13} /> {t('friends.lan_title')}</span>
                      <span className="friend-lan-meta">
                        {t('friends.version_prefix', { game: String(p.game || ''), loader: loaderLabel(p.loader) })}
                        {matches && matches.length > 0
                          ? ` · ${t('friends.lan_ready', { name: matches[0].name })}`
                          : p.mods
                            ? ` · ${t('friends.lan_mods_differ')}`
                            : ''}
                      </span>
                    </div>
                  )}
                  {!isLan && p?.state === 'server' && p.server && (
                    <div className="friend-lan">
                      <span className="friend-lan-title"><Globe size={13} /> {t('friends.server_title')}</span>
                      <span className="friend-lan-meta">{t('friends.version_prefix', { game: String(p.game || ''), loader: loaderLabel(p.loader) })}</span>
                    </div>
                  )}
                  {!isLan && p?.state === 'menu' && p.game && (
                    <div className="friend-lan">
                      <span className="friend-lan-title"><Gamepad2 size={13} /> {t('friends.in_game_title')}</span>
                      <span className="friend-lan-meta">{t('friends.version_prefix', { game: String(p.game || ''), loader: loaderLabel(p.loader) })}</span>
                    </div>
                  )}
                </div>
                <div className="friend-actions">
                  {isLan && address && p && (
                    <Button variant={matches && matches.length > 0 ? 'primary' : 'secondary'} size="sm" onClick={() => void copyAddress(f, p)}>
                      {copied === address ? <Check size={14} /> : <Copy size={14} />}
                      {copied === address ? t('friends.copied') : address}
                    </Button>
                  )}
                  <button className="friend-remove" title="Remove friend" onClick={() => void handleRemove(f)}>
                    <X size={15} />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {presence?.friends && presence.friends.some((f) => f.state === 'lan' && isOnline(f)) && (
        <p className="friend-hint">
          <Signal size={13} /> {t('friends.lan_hint2')}
        </p>
      )}
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Globe, Plus, LogIn, LogOut, Copy, Check, Users, Wifi, WifiOff, Shield, Gamepad2, Send, MessageCircle, Settings, Loader2, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { Input } from '@/components/Input';
import { useNotificationStore } from '@/store/notification-store';
import type { NetworkInfo, NetworkPeer, NetworkChatMessage } from '@shared/types';
import './NetworkPage.css';

function NetworkSkinHead({ skin, size = 36 }: { skin: string | null | undefined; size?: number }) {
  const [failed, setFailed] = useState(false);
  const src = skin ? `data:image/png;base64,${skin}` : null;
  if (failed || !src) {
    return (
      <div className="network-peer-avatar">
        <Gamepad2 size={18} />
      </div>
    );
  }
  return (
    <div
      className="network-peer-avatar"
      style={{
        backgroundImage: `url(${src})`,
        backgroundSize: `${size * 8}px`,
        backgroundPosition: '0 0',
        imageRendering: 'pixelated',
      }}
      role="img"
    >
      <img src={src} alt="" style={{ display: 'none' }} onError={() => setFailed(true)} />
    </div>
  );
}

// Internet-mode options for the create form, shown as selectable cards.
const INTERNET_MODES = [
  {
    value: 'auto' as const,
    icon: <Globe size={18} />,
    title: 'Auto (recommended)',
    desc: 'Open the router port via UPnP and detect your public IP.',
  },
  {
    value: 'manual' as const,
    icon: <Settings size={18} />,
    title: 'Manual',
    desc: 'You already forwarded a port on your router.',
  },
  {
    value: 'lan' as const,
    icon: <Wifi size={18} />,
    title: 'LAN only',
    desc: 'Only players on the same Wi-Fi / router.',
  },
];

export function NetworkPage() {
  const { add } = useNotificationStore();
  const [info, setInfo] = useState<NetworkInfo | null>(null);
  const [networkName, setNetworkName] = useState('');
  const [joinKey, setJoinKey] = useState('');
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);
  const [copied, setCopied] = useState(false);
  // Internet mode: auto = try UPnP port mapping + public IP; manual = user
  // forwarded a port on the router; lan = local network only.
  const [internetMode, setInternetMode] = useState<'auto' | 'manual' | 'lan'>('auto');
  const [manualIp, setManualIp] = useState('');
  const [manualPort, setManualPort] = useState('');
  const [ztInstalling, setZtInstalling] = useState(false);
  const [ztInstalled, setZtInstalled] = useState(false);
  const [ztConnected, setZtConnected] = useState(false);
  const [radminRunning, setRadminRunning] = useState(false);
  // Chat
  const [chatMessages, setChatMessages] = useState<NetworkChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);

  const inNetwork = !!info?.id;

  // Tracks which network the chat currently belongs to, so messages from a
  // previous network (e.g. after auto-restore re-joined with a new id) are
  // cleared instead of lingering on screen.
  const lastNetIdRef = useRef<string | null>(null);

  // Merges incoming chat messages with what is already displayed, deduping by
  // id and keeping chronological order. Handles the host's history relay, the
  // sender's local echo and live messages without duplicates.
  const mergeMessages = useCallback((incoming: NetworkChatMessage[]) => {
    if (!incoming.length) return;
    setChatMessages((prev) => {
      const map = new Map<string, NetworkChatMessage>();
      for (const m of [...prev, ...incoming]) {
        if (m && m.id) map.set(m.id, m);
      }
      return [...map.values()].sort((a, b) => a.timestamp - b.timestamp);
    });
  }, []);

  const applyInfo = useCallback((n: NetworkInfo) => {
    setInfo(n);
    if (n.id !== lastNetIdRef.current) {
      lastNetIdRef.current = n.id;
      setChatMessages([]);
    }
    if (n.chatHistory?.length) mergeMessages(n.chatHistory);
  }, [mergeMessages]);

  // Load current network info
  useEffect(() => {
    window.slime.network.info().then((i) => applyInfo(i as NetworkInfo)).catch(() => { /* service not ready */ });
    window.slime.zerotier.status().then((s) => { setZtInstalled(s.installed); setZtConnected(s.connected); setRadminRunning(s.radminRunning); }).catch(() => { /* service not ready */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Listen for live updates pushed by the main process.
  useEffect(() => {
    const unsubUpdate = window.slime.network.onUpdate((i) => applyInfo(i as NetworkInfo));
    const unsubChat = window.slime.network.onChat((msg) => {
      mergeMessages([msg as NetworkChatMessage]);
    });
    const unsubHistory = window.slime.network.onChatHistory((msgs) => {
      mergeMessages(msgs as NetworkChatMessage[]);
    });
    return () => { unsubUpdate(); unsubChat(); unsubHistory(); };
  }, [applyInfo, mergeMessages]);

  // Poll for real-time updates so the peer list, chat and connection state
  // stay fresh even if a push event was missed (e.g. the page was not open).
  useEffect(() => {
    const t = setInterval(() => {
      window.slime.network.info().then((i) => applyInfo(i as NetworkInfo)).catch(() => { /* service not ready */ });
    }, 2500);
    return () => clearInterval(t);
  }, [inNetwork, applyInfo]);

  // ZeroTier status can change after install (or a manual install outside the
  // launcher) — poll so the banner and buttons react without a page reload.
  useEffect(() => {
    const t = setInterval(() => {
      window.slime.zerotier.status().then((s) => { setZtInstalled(s.installed); setZtConnected(s.connected); setRadminRunning(s.radminRunning); }).catch(() => { /* service not ready */ });
    }, 4000);
    return () => clearInterval(t);
  }, []);

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  const handleCreate = async () => {
    setCreating(true);
    try {
      const res = await window.slime.network.create(
        networkName,
        internetMode === 'manual'
          ? { internetMode, manualIp: manualIp.trim(), manualPort: parseInt(manualPort, 10) || undefined }
          : { internetMode },
      ) as { ok: boolean; network?: NetworkInfo; error?: string };
      if (res.ok && res.network) {
        setInfo(res.network);
        lastNetIdRef.current = res.network.id;
        setChatMessages([]);
        add({ type: 'success', title: 'Network created', message: `Share the key with friends so they can join.`, duration: 4000 });
      } else {
        add({ type: 'error', title: 'Failed', message: res.error || 'Could not create network.', duration: 4000 });
      }
    } catch (e) {
      add({ type: 'error', title: 'Failed', message: String(e), duration: 4000 });
    } finally {
      setCreating(false);
    }
  };

  const handleJoin = async () => {
    if (!joinKey.trim()) return;
    setJoining(true);
    try {
      const res = await window.slime.network.join(joinKey.trim()) as { ok: boolean; network?: NetworkInfo; error?: string };
      if (res.ok && res.network) {
        setInfo(res.network);
        lastNetIdRef.current = res.network.id;
        setChatMessages([]);
        add({ type: 'success', title: 'Joined network', message: 'You are now connected to the network.', duration: 3000 });
      } else {
        add({ type: 'error', title: 'Failed to join', message: res.error || 'Invalid key or host unreachable.', duration: 4000 });
      }
    } catch (e) {
      add({ type: 'error', title: 'Failed to join', message: String(e), duration: 4000 });
    } finally {
      setJoining(false);
    }
  };

  const handleLeave = async () => {
    await window.slime.network.leave();
    setInfo(null);
    lastNetIdRef.current = null;
    setChatMessages([]);
    add({ type: 'info', title: 'Left network', message: 'You disconnected from the network.', duration: 3000 });
  };

  const handleInstallZeroTier = async () => {
    setZtInstalling(true);
    try {
      const res = await window.slime.zerotier.install() as { ok: boolean; error?: string; installed?: boolean };
      const st = await window.slime.zerotier.status() as { installed: boolean };
      setZtInstalled(st.installed || !!res.installed);
      if (res.ok) {
        add({
          type: 'success',
          title: 'ZeroTier VPN installed',
          message: 'Join the same ZeroTier network with friends and create a Network here — the key will use the VPN IP automatically.',
          duration: 8000,
        });
      } else {
        add({ type: 'error', title: 'ZeroTier install failed', message: res.error || 'Unknown error', duration: 6000 });
      }
    } catch (e) {
      add({ type: 'error', title: 'ZeroTier install failed', message: String(e), duration: 6000 });
    } finally {
      setZtInstalling(false);
    }
  };

  const copyKey = async () => {
    if (!info?.key) return;
    try {
      await navigator.clipboard.writeText(info.key);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  };

  const sendChat = async () => {
    if (!chatInput.trim()) return;
    await window.slime.network.chatSend(chatInput.trim());
    setChatInput('');
  };

  const handleChatKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void sendChat();
    }
  };

  const clientConnecting = inNetwork && !info.isHost && info.connection === 'connecting';
  const clientDisconnected = inNetwork && !info.isHost && info.connection === 'disconnected';

  return (
    <div className="network-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Network</h1>
          <p className="page-subtitle">
            {inNetwork
              ? info.isHost ? `Hosting: ${info.name}` : `Connected to ${info.hostIp}:${info.hostPort}`
              : 'Create or join a network to play together over the internet.'}
          </p>
        </div>
        {inNetwork && (
          <Button variant="danger" icon={<LogOut size={16} />} onClick={handleLeave}>
            Leave Network
          </Button>
        )}
      </div>

      {!inNetwork && !ztConnected && !radminRunning && (
        <div className="network-vpn-banner network-vpn-banner-warn">
          <AlertTriangle size={16} />
          <div>
            <strong>No VPN detected</strong>
            <p>
              Neither ZeroTier nor Radmin VPN is running. Without a VPN, only players on the same Wi-Fi / router can join your network.
              {ztInstalled
                ? ' ZeroTier is installed — open the ZeroTier client and join a network to play over the internet.'
                : ' Install ZeroTier or Radmin VPN to play with friends over the internet.'}
            </p>
          </div>
        </div>
      )}
      {!inNetwork && (ztConnected || radminRunning) && (
        <div className="network-vpn-banner network-vpn-banner-ok">
          <Shield size={16} />
          <div>
            <strong>{ztConnected ? 'ZeroTier' : 'Radmin VPN'} is active</strong>
            <p>
              Your VPN is running. Players on the same VPN network can join using the key — create or join a network to get started.
            </p>
          </div>
        </div>
      )}

      {!inNetwork ? (
        <div className="network-setup">
          {/* Create Network */}
          <Card className="network-action-card">
            <div className="network-action-head">
              <div className="network-action-icon network-action-icon-create">
                <Plus size={22} />
              </div>
              <div>
                <h3>Create a Network</h3>
                <p>Host a network and invite friends to join.</p>
              </div>
            </div>
            <div className="network-action-body">
              <Input
                label="Network name"
                placeholder="My Minecraft Network"
                value={networkName}
                onChange={(e) => setNetworkName(e.target.value)}
              />
              <label className="input-label">Internet mode — play from anywhere</label>
              <div className="network-mode-grid" role="radiogroup" aria-label="Internet mode">
                {INTERNET_MODES.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    role="radio"
                    aria-checked={internetMode === opt.value}
                    className={`network-mode-card${internetMode === opt.value ? ' network-mode-card-active' : ''}`}
                    onClick={() => setInternetMode(opt.value)}
                  >
                    <span className="network-mode-card-icon">{opt.icon}</span>
                    <span className="network-mode-card-text">
                      <span className="network-mode-card-title">{opt.title}</span>
                      <span className="network-mode-card-desc">{opt.desc}</span>
                    </span>
                  </button>
                ))}
              </div>
              {internetMode === 'manual' && (
                <div className="network-manual-row">
                  <Input
                    label="Public IP"
                    placeholder="e.g. 85.143.12.34"
                    value={manualIp}
                    onChange={(e) => setManualIp(e.target.value)}
                  />
                  <Input
                    label="Forwarded port"
                    placeholder="e.g. 25565"
                    value={manualPort}
                    onChange={(e) => setManualPort(e.target.value)}
                  />
                </div>
              )}
              {internetMode === 'lan' && (
                <p className="network-key-hint">Only players on the same Wi-Fi/router can join.</p>
              )}
              <Button
                variant="primary"
                icon={<Globe size={16} />}
                loading={creating}
                onClick={handleCreate}
              >
                Create Network
              </Button>
            </div>
          </Card>

          {/* Join Network */}
          <Card className="network-action-card">
            <div className="network-action-head">
              <div className="network-action-icon network-action-icon-join">
                <LogIn size={22} />
              </div>
              <div>
                <h3>Join a Network</h3>
                <p>Enter a network key from a friend to connect.</p>
              </div>
            </div>
            <div className="network-action-body">
              <Input
                label="Network key"
                placeholder="Paste the network key here..."
                value={joinKey}
                onChange={(e) => setJoinKey(e.target.value)}
              />
              <Button
                variant="primary"
                icon={<Wifi size={16} />}
                loading={joining}
                disabled={!joinKey.trim()}
                onClick={handleJoin}
              >
                Join Network
              </Button>
            </div>
          </Card>

          <div className="network-info-box">
            <Shield size={16} />
            <div>
              <strong>How it works</strong>
              <p>
                The network creates a direct connection between players.
                The host shares a key, and others paste it to join.
                Once connected, you can see each other's nicknames, IPs, and game status.
                Open a LAN world in Minecraft and your friends can connect using your IP and port.
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="network-active">
          <div className="network-active-grid">
            {/* Left: Info + Peers */}
            <div className="network-active-left">
              {/* Network Info Card */}
              <Card className="network-info-card">
                <div className="network-info-head">
                  <div className="network-info-status">
                    <span className="network-status-dot network-status-dot-live" />
                    <span>{info.isHost ? 'Hosting' : 'Connected'}</span>
                  </div>
                  <h2>{info.name}</h2>
                </div>

                {info.isHost && (
                  <div className="network-key-section">
                    <label className="input-label">Network Key — share with friends</label>
                    <div className="network-key-row">
                      <code className="network-key-value">{info.key}</code>
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={copied ? <Check size={14} /> : <Copy size={14} />}
                        onClick={copyKey}
                      >
                        {copied ? 'Copied!' : 'Copy'}
                      </Button>
                    </div>
                    <p className="network-key-hint">
                      Friends paste this key in the "Join a Network" section to connect.
                    </p>
                  </div>
                )}

                <div className="network-host-info">
                  <div className="network-host-detail">
                    <span className="network-detail-label">Host IP</span>
                    <span className="network-detail-value">{info.hostIp}</span>
                  </div>
                  {info.hostGamePort ? (
                    <div className="network-host-detail">
                      <span className="network-detail-label">Game Port</span>
                      <span className="network-detail-value">{info.hostGamePort}</span>
                    </div>
                  ) : null}
                  <div className="network-host-detail">
                    <span className="network-detail-label">Players</span>
                    <span className="network-detail-value">{info.peers.length + 1}</span>
                  </div>
                </div>

                {info.isHost && info.internetMode === 'upnp' && (
                  <div className="network-internet-banner network-internet-banner-ok">
                    <Globe size={14} />
                    <span>Internet mode active — public IP {info.publicIp}, port mapped via UPnP. Friends can join from anywhere.</span>
                  </div>
                )}
                {info.isHost && info.internetMode === 'manual' && (
                  <div className="network-internet-banner network-internet-banner-ok">
                    <Globe size={14} />
                    <span>Internet mode active (manual) — friends connect to {info.hostIp}:{info.hostPort}.</span>
                  </div>
                )}
                {info.isHost && info.internetMode === 'lan' && (
                  <div className="network-internet-banner">
                    <Wifi size={14} />
                    <span>
                      {ztConnected
                        ? 'ZeroTier VPN is connected — your friends on the same ZeroTier network can join using this key.'
                        : radminRunning
                          ? 'Radmin VPN is active — your friends on the same Radmin network can join using this key.'
                          : ztInstalled
                            ? 'ZeroTier is installed but not connected — open the ZeroTier client and join a network to play over the internet.'
                            : info.publicIp
                              ? `UPnP is unavailable — to play over the internet, forward port ${info.hostPort} on your router manually (public IP ${info.publicIp}) or install ZeroTier VPN.`
                              : 'Internet access unavailable — only players on the same Wi-Fi / router can join. Install ZeroTier or Radmin VPN to play from anywhere.'}
                    </span>
                    {ztInstalling ? (
                      <span className="network-zt-installed" style={{ marginLeft: 'auto', flexShrink: 0 }}>
                        <Loader2 size={14} className="network-spin" /> Installing…
                      </span>
                    ) : !ztInstalled ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<Shield size={14} />}
                        onClick={() => void handleInstallZeroTier()}
                        style={{ marginLeft: 'auto', flexShrink: 0 }}
                      >
                        Install ZeroTier
                      </Button>
                    ) : (
                      <span className="network-zt-installed" style={{ marginLeft: 'auto', flexShrink: 0 }}>
                        <Shield size={14} /> Installed
                      </span>
                    )}
                  </div>
                )}

                {!info.isHost && clientDisconnected && (
                  <div className="network-internet-banner">
                    <WifiOff size={14} />
                    <span>{info.connectionError || 'Disconnected from the host.'} You can leave and re-join with the same key.</span>
                  </div>
                )}
                {!info.isHost && clientConnecting && (
                  <div className="network-internet-banner">
                    <Loader2 size={14} className="network-spin" />
                    <span>Connecting to the host…</span>
                  </div>
                )}
              </Card>

              {/* Peers List */}
              <Card className="network-peers-card">
                <div className="network-peers-head">
                  <h3><Users size={16} /> Connected Players</h3>
                  <span className="network-peer-count">{info.peers.length + 1}</span>
                </div>

                <div className="network-peer-item network-peer-self">
                  <NetworkSkinHead skin={info.isHost ? info.hostSkin : info.selfSkin} />
                  <div className="network-peer-info">
                    <span className="network-peer-name">{info.isHost ? 'You (Host)' : 'You'}</span>
                    <span className="network-peer-detail">{info.selfIp || '—'}</span>
                  </div>
                  {info.selfGamePort ? (
                    <span className="network-peer-badge network-peer-badge-playing">
                      <Gamepad2 size={11} /> Port {info.selfGamePort}
                    </span>
                  ) : (
                    <span className="network-peer-badge network-peer-badge-host">
                      {info.isHost ? 'HOST' : 'ONLINE'}
                    </span>
                  )}
                </div>

                <AnimatePresence>
                  {info.peers.map((peer) => (
                    <motion.div
                      key={peer.id}
                      className="network-peer-item"
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, x: -20 }}
                      transition={{ duration: 0.2 }}
                    >
                      <NetworkSkinHead skin={peer.skin} />
                      <div className="network-peer-info">
                        <span className="network-peer-name">{peer.nick}</span>
                        {/* Only the IP — peer.port is the connection's
                            ephemeral source port, it changes on every
                            reconnect and means nothing to the viewer. */}
                        <span className="network-peer-detail">{peer.ip}</span>
                      </div>
                      {peer.gamePort ? (
                        <span className="network-peer-badge network-peer-badge-playing">
                          <Gamepad2 size={11} /> Port {peer.gamePort}
                        </span>
                      ) : (
                        <span className="network-peer-badge network-peer-badge-online">Online</span>
                      )}
                    </motion.div>
                  ))}
                </AnimatePresence>

                {info.peers.length === 0 && !info.isHost && (
                  <div className="network-peers-empty">
                    {clientConnecting ? <Loader2 size={20} className="network-spin" /> : <WifiOff size={20} />}
                    <span>
                      {clientConnecting
                        ? 'Connecting to the host…'
                        : clientDisconnected
                          ? 'Could not reach the host.'
                          : 'Waiting for other players...'}
                    </span>
                  </div>
                )}
              </Card>

              {/* Help */}
              <div className="network-help">
                <h4>How to play together</h4>
                <ol>
                  <li>All players must be connected to this network.</li>
                  <li>One player opens a <strong>LAN world</strong> in Minecraft (singleplayer → Open to LAN).</li>
                  <li>The host's game port will appear next to their name above.</li>
                  <li>Other players connect using: <code>{info.hostIp}:{info.hostGamePort || '<game port>'}</code></li>
                </ol>
              </div>
            </div>

            {/* Right: Chat */}
            <div className="network-chat-card">
              <Card className="network-chat">
                <div className="network-chat-head">
                  <h3><MessageCircle size={16} /> Network Chat</h3>
                  <span className="network-chat-count">{chatMessages.length}</span>
                </div>
                <div className="network-chat-messages">
                  {chatMessages.length === 0 && (
                    <div className="network-chat-empty">
                      <MessageCircle size={20} />
                      <span>No messages yet. Say hello!</span>
                    </div>
                  )}
                  {chatMessages.map((msg) => {
                    const isSystem = msg.senderNick === 'System' && !msg.senderUuid;
                    if (isSystem) {
                      return (
                        <div key={msg.id} className="network-chat-sys">
                          <span>{msg.text}</span>
                        </div>
                      );
                    }

                    const isOwn = !!msg.senderUuid && !!info.selfUuid && msg.senderUuid === info.selfUuid;
                    return (
                      <div key={msg.id} className={`network-chat-msg${isOwn ? ' network-chat-msg-self' : ''}`}>
                        <div className="network-chat-bubble">
                          {!isOwn && <span className="network-chat-sender">{msg.senderNick}</span>}
                          <span className="network-chat-text">{msg.text}</span>
                          <span className="network-chat-time">
                            {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                  <div ref={chatEndRef} />
                </div>
                <div className="network-chat-input">
                  <input
                    className="network-chat-field"
                    placeholder="Type a message..."
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={handleChatKeyDown}
                  />
                  <Button
                    variant="primary"
                    size="sm"
                    icon={<Send size={14} />}
                    disabled={!chatInput.trim()}
                    onClick={() => void sendChat()}
                  />
                </div>
              </Card>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
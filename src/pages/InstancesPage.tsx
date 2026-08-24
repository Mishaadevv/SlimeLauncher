import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, Play, Pencil, Copy, Trash2, FolderOpen, Cpu, MemoryStick, Wrench, X, AlertTriangle, Archive, RotateCcw, Server as ServerIcon, Square } from 'lucide-react';
import { useInstanceStore } from '@/store/instance-store';
import { useSettingsStore } from '@/store/settings-store';
import { useNotificationStore } from '@/store/notification-store';
import { Card } from '@/components/Card';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { EmptyState } from '@/components/EmptyState';
import { AppIcon } from '@/components/AppIcon';
import { t } from '@/lib/i18n';
import type { LoaderType, MinecraftInstance, WorldBackup, DedicatedServer } from '@shared/types';
import './InstancesPage.css';

const LOADERS: { id: LoaderType; label: string }[] = [
  { id: 'vanilla', label: 'Vanilla' },
  { id: 'fabric', label: 'Fabric' },
  { id: 'forge', label: 'Forge' },
  { id: 'neoforge', label: 'NeoForge' },
  { id: 'quilt', label: 'Quilt' },
];

function formatEta(seconds: number): string {
  const s = Math.max(1, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return rest > 0 ? `${m} min ${rest} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return rest > 0 ? `${h} h ${m % 60} min` : `${h} h`;
}

interface FormState {
  name: string;
  mcVersion: string;
  loader: LoaderType;
  ramMB: number;
  jvmArgs: string;
}

const EMPTY_FORM: FormState = { name: '', mcVersion: '1.20.1', loader: 'fabric', ramMB: 4096, jvmArgs: '' };

export function InstancesPage() {
  const { instances, load, create, update, remove, duplicate, select, selectedId } = useInstanceStore();
  const { settings } = useSettingsStore();
  const { add } = useNotificationStore();
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<MinecraftInstance | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [mcVersions, setMcVersions] = useState<string[]>([]);
  // Live launch progress (mirrors the Home page's Play flow)
  const [launchingId, setLaunchingId] = useState<string | null>(null);
  const [launchStage, setLaunchStage] = useState('');
  const [launchProgress, setLaunchProgress] = useState(0);
  const [launchEta, setLaunchEta] = useState<string | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [launchErrorId, setLaunchErrorId] = useState<string | null>(null);
  // World backups modal state
  const [backupsInst, setBackupsInst] = useState<MinecraftInstance | null>(null);
  const [backups, setBackups] = useState<WorldBackup[]>([]);
  const [backupsLoading, setBackupsLoading] = useState(false);
  const [backupsBusy, setBackupsBusy] = useState<string | null>(null);
  // Dedicated servers modal state
  const [showServers, setShowServers] = useState(false);
  const [servers, setServers] = useState<DedicatedServer[]>([]);
  const [serverStates, setServerStates] = useState<Record<string, { state: string; log: string[] }>>({});
  const [serversLoading, setServersLoading] = useState(false);
  const [serverBusy, setServerBusy] = useState<string | null>(null);
  const [srvName, setSrvName] = useState('');
  const [srvVersion, setSrvVersion] = useState('1.21.1');
  const [srvFlavor, setSrvFlavor] = useState<'vanilla' | 'paper'>('paper');
  const [srvPort, setSrvPort] = useState(25565);
  const [srvRam, setSrvRam] = useState(2048);
  const [srvMotd, setSrvMotd] = useState('SlimeLauncher server');
  const [srvOnlineMode, setSrvOnlineMode] = useState(false);

  useEffect(() => {
    void loadVersions();
  }, []);

  // Dedicated servers: live status/log stream
  useEffect(() => {
    const unsub = window.slime.servers.onStatus((s) => {
      setServerStates((prev) => ({
        ...prev,
        [s.id]: {
          state: s.state,
          log: s.line ? [...(prev[s.id]?.log || []), s.line].slice(-200) : (prev[s.id]?.log || []),
        },
      }));
    });
    return () => { unsub(); };
  }, []);

  const reloadServers = async () => {
    setServersLoading(true);
    try {
      type ServerRow = DedicatedServer & { runtime?: { state: string; logTail: string[] } };
      const rows = ((await window.slime.servers.list()) || []) as ServerRow[];
      setServers(rows.map(({ runtime, ...s }) => {
        if (runtime) {
          setServerStates((prev) => ({ ...prev, [s.id]: { state: runtime.state, log: prev[s.id]?.log || runtime.logTail } }));
        }
        return s;
      }));
    } catch {
      setServers([]);
    } finally {
      setServersLoading(false);
    }
  };

  const openServers = () => {
    setShowServers(true);
    void reloadServers();
  };

  const createServer = async () => {
    if (!srvName.trim() || !srvVersion.trim()) return;
    setServerBusy('create');
    try {
      const res = await window.slime.servers.create({
        name: srvName.trim(),
        mcVersion: srvVersion.trim(),
        flavor: srvFlavor,
        port: srvPort,
        ramMb: srvRam,
        motd: srvMotd,
        onlineMode: srvOnlineMode,
      }) as { ok: boolean; error?: string };
      if (!res.ok) {
        add({ type: 'error', title: t('servers.create_failed'), message: res.error || t('common.unknown_error'), duration: 6000 });
      } else {
        add({ type: 'success', title: t('servers.created_title'), message: t('servers.created_msg'), duration: 3500 });
        setSrvName('');
        await reloadServers();
      }
    } finally {
      setServerBusy(null);
    }
  };

  const loadVersions = async () => {
    try {
      const result = await window.slime.mc.versions();
      const list = (result?.versions || []).map((v: { id: string }) => v.id);
      setMcVersions(list);
    } catch { /* ignore — free-text still works */ }
  };

  const openCreate = () => {
    setForm({ ...EMPTY_FORM, ramMB: settings.defaultRamMB, jvmArgs: settings.jvmArguments });
    void loadVersions();
    setEditing(null);
    setShowCreate(true);
  };

  const openEdit = (inst: MinecraftInstance) => {
    setForm({ name: inst.name, mcVersion: inst.mcVersion, loader: inst.loader, ramMB: inst.ramMB, jvmArgs: inst.jvmArgs });
    setEditing(inst);
    setShowCreate(true);
    void loadVersions();
  };

  const handleSave = async () => {
    if (!form.name.trim()) return;
    setSaving(true);
    let ok = true;
    if (editing) {
      ok = await update(editing.id, { name: form.name, mcVersion: form.mcVersion, loader: form.loader, ramMB: form.ramMB, jvmArgs: form.jvmArgs });
      if (ok) add({ type: 'success', title: t('instances.updated_title'), message: t('instances.updated_msg', { name: form.name }), duration: 3000 });
    } else {
      const inst = await create({ name: form.name, mcVersion: form.mcVersion, loader: form.loader, ramMB: form.ramMB, jvmArgs: form.jvmArgs });
      if (inst) {
        add({ type: 'success', title: t('instances.created_title'), message: t('instances.created_msg', { name: inst.name }), duration: 3000 });
      } else {
        ok = false;
      }
    }
    setSaving(false);
    // Keep the modal open on failure so the entered form data is not lost
    // (the error itself was already shown as a notification).
    if (ok) setShowCreate(false);
  };

  const handleDelete = async (inst: MinecraftInstance) => {
    if (!confirm(t('instances.delete_confirm', { name: inst.name }))) return;
    const ok = await remove(inst.id);
    if (ok) add({ type: 'info', title: t('instances.deleted_title'), message: t('instances.deleted_msg', { name: inst.name }), duration: 3000 });
  };

  const openBackups = async (inst: MinecraftInstance) => {
    setBackupsInst(inst);
    setBackupsLoading(true);
    try {
      setBackups(((await window.slime.worldBackups.list(inst.id)) || []) as WorldBackup[]);
    } catch {
      setBackups([]);
    } finally {
      setBackupsLoading(false);
    }
  };

  const createBackup = async (inst: MinecraftInstance) => {
    setBackupsBusy('create');
    try {
      const res = await window.slime.worldBackups.create(inst.id) as { ok: boolean; error?: string };
      if (res.ok) {
        add({ type: 'success', title: t('backups.created_title'), message: t('backups.created_msg'), duration: 3000 });
      } else {
        add({ type: 'error', title: t('backups.failed_title'), message: res.error || t('common.unknown_error'), duration: 4000 });
      }
      await openBackups(inst);
    } finally {
      setBackupsBusy(null);
    }
  };

  const restoreBackup = async (b: WorldBackup, inst: MinecraftInstance) => {
    if (!confirm(t('backups.restore_confirm', { date: new Date(b.createdAt).toLocaleString() }))) return;
    setBackupsBusy(b.id);
    try {
      const res = await window.slime.worldBackups.restore(b.id, inst.id) as { ok: boolean; error?: string };
      add(res.ok
        ? { type: 'success', title: t('backups.restored_title'), message: t('backups.restored_msg'), duration: 3000 }
        : { type: 'error', title: t('backups.restore_failed'), message: res.error || t('common.unknown_error'), duration: 5000 });
    } finally {
      setBackupsBusy(null);
    }
  };

  const deleteBackup = async (b: WorldBackup, inst: MinecraftInstance) => {
    setBackupsBusy(b.id);
    try {
      await window.slime.worldBackups.delete(b.id);
      await openBackups(inst);
    } finally {
      setBackupsBusy(null);
    }
  };

  const handleLaunch = async (inst: MinecraftInstance) => {
    select(inst.id);
    setLaunchingId(inst.id);
    setLaunchStage(t('instances.preparing'));
    setLaunchProgress(0.05);
    setLaunchEta(null);
    setLaunchError(null);
    setLaunchErrorId(null);
    // Estimate remaining time from the progress rate over recent samples.
    const samples: { p: number; t: number }[] = [];
    const unsub = window.slime.mc.onLaunchProgress((p) => {
      setLaunchStage(p.message);
      setLaunchProgress(p.progress);
      samples.push({ p: p.progress, t: Date.now() });
      if (samples.length > 30) samples.shift();
      if (p.progress > 0.03 && p.progress < 0.98) {
        const recent = samples.slice(-8);
        if (recent.length >= 2) {
          const dt = (recent[recent.length - 1].t - recent[0].t) / 1000;
          const dp = recent[recent.length - 1].p - recent[0].p;
          if (dt > 0.8 && dp > 0.001) {
            const eta = (1 - p.progress) / (dp / dt);
            if (eta > 2 && eta < 3600 * 4) {
              setLaunchEta(`≈ ${formatEta(eta)} left`);
              return;
            }
          }
        }
      }
      setLaunchEta(null);
    });
    try {
      const res = await window.slime.mc.launch(inst.id);
      if (!res.ok) {
        setLaunchError(res.error || t('home.launch_error_unknown'));
        setLaunchErrorId(inst.id);
        add({ type: 'error', title: t('instances.launch_failed'), message: res.error || t('home.launch_error_unknown'), duration: 8000 });
      }
    } catch (e) {
      setLaunchError(String(e));
      setLaunchErrorId(inst.id);
      add({ type: 'error', title: t('instances.launch_failed'), message: String(e), duration: 8000 });
    } finally {
      unsub();
      // Keep the error visible after the spinner stops so the player can read
      // what went wrong instead of a toast that vanishes in seconds.
      setTimeout(() => { setLaunchingId(null); setLaunchStage(''); setLaunchProgress(0); setLaunchEta(null); }, 1500);
    }
  };

  return (
    <div className="instances-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('instances.title')}</h1>
          <p className="page-subtitle">{t('instances.subtitle')}</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="secondary" icon={<ServerIcon size={16} />} onClick={openServers}>
            {t('servers.title')}
          </Button>
          <Button variant="primary" icon={<Plus size={16} />} onClick={openCreate}>
            {t('instances.create')}
          </Button>
        </div>
      </div>

      {instances.length === 0 ? (
        <EmptyState
          title={t('home.no_instances.title')}
          description={t('home.no_instances.desc')}
          action={<Button variant="primary" size="lg" icon={<Plus size={18} />} onClick={openCreate}>{t('instances.create')}</Button>}
        />
      ) : (
        <div className="instances-grid">
          <AnimatePresence>
            {instances.map((inst) => (
              <motion.div
                key={inst.id}
                layout
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
              >
                <Card hover className={`instance-card ${inst.id === selectedId ? 'instance-card-selected' : ''}`} onClick={() => select(inst.id)}>
                  <div className="instance-card-top">
                    <div className="instance-card-icon">
                      {inst.icon ? <img src={inst.icon} alt="" /> : <AppIcon size={40} />}
                    </div>
                    <div className="instance-card-info">
                      <h3 className="instance-card-name">{inst.name}</h3>
                      <div className="instance-card-meta">
                        <span><Cpu size={12} /> {inst.mcVersion}</span>
                        <span><Wrench size={12} /> {inst.loader}</span>
                        <span><MemoryStick size={12} /> {inst.ramMB / 1024 >= 1 ? `${(inst.ramMB / 1024).toFixed(0)} GB` : `${inst.ramMB} MB`}</span>
                      </div>
                    </div>
                  </div>
                  <div className="instance-card-actions">
                    <Button
                      variant="primary"
                      size="sm"
                      loading={launchingId === inst.id}
                      icon={<Play size={14} fill="currentColor" />}
                      onClick={(e) => { e.stopPropagation(); handleLaunch(inst); }}
                    >
                      {launchingId === inst.id ? launchStage || t('instances.launching') : t('instances.play')}
                    </Button>
                    <Button variant="ghost" size="sm" icon={<Pencil size={14} />} onClick={(e) => { e.stopPropagation(); openEdit(inst); }} />
                    <Button variant="ghost" size="sm" icon={<Archive size={14} />} title={t('backups.title')} onClick={(e) => { e.stopPropagation(); void openBackups(inst); }} />
                    <Button variant="ghost" size="sm" icon={<Copy size={14} />} onClick={(e) => { e.stopPropagation(); duplicate(inst.id); }} />
                    <Button variant="ghost" size="sm" icon={<FolderOpen size={14} />} onClick={(e) => { e.stopPropagation(); window.slime.instance.openFolder(inst.id); }} />
                    <Button variant="ghost" size="sm" className="danger-icon" icon={<Trash2 size={14} />} onClick={(e) => { e.stopPropagation(); handleDelete(inst); }} />
                  </div>
                  {launchingId === inst.id && (
                    <div className="launch-progress launch-progress-card">
                      <div className="launch-progress-bar">
                        <div className="launch-progress-fill" style={{ width: `${Math.max(launchProgress * 100, 2)}%` }} />
                      </div>
                      <span className="launch-progress-text">
                        {launchStage}
                        {launchEta && <span className="launch-eta"> · {launchEta}</span>}
                      </span>
                    </div>
                  )}
                  {launchErrorId === inst.id && launchError && (
                    <div className="launch-error launch-error-card" role="alert">
                      <AlertTriangle size={13} className="launch-error-icon" />
                      <span className="launch-error-text">{launchError}</span>
                      <button
                        className="launch-error-dismiss"
                        onClick={() => { setLaunchError(null); setLaunchErrorId(null); }}
                        aria-label="Dismiss"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  )}
                </Card>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}

      {/* Create/Edit modal */}
      <AnimatePresence>
        {showCreate && (
          <motion.div
            className="modal-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setShowCreate(false)}
          >
            <motion.div
              className="modal"
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="modal-header">
                <h2>{editing ? t('instances.edit') : t('instances.create')}</h2>
                <button className="modal-close" onClick={() => setShowCreate(false)}><X size={16} /></button>
              </div>
              <div className="modal-body">
                <Input
                  label={t('instances.name')}
                  placeholder={t('instances.name_placeholder')}
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
                <div className="form-row">
                  <div className="form-field">
                    <label className="input-label">{t('instances.mc_version')}</label>
                    <div className="input-box">
                      <input
                        className="input"
                        list="mc-version-list"
                        placeholder="1.20.1"
                        value={form.mcVersion}
                        onChange={(e) => setForm({ ...form, mcVersion: e.target.value })}
                      />
                    </div>
                    <datalist id="mc-version-list">
                      {mcVersions.map((v) => <option key={v} value={v} />)}
                    </datalist>
                  </div>
                  <div className="form-field">
                    <label className="input-label">{t('instances.loader')}</label>
                    <div className="loader-pills">
                      {LOADERS.map((l) => (
                        <button
                          key={l.id}
                          className={`loader-pill ${form.loader === l.id ? 'loader-pill-active' : ''}`}
                          onClick={() => setForm({ ...form, loader: l.id })}
                        >
                          {l.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="form-row">
                  <Input
                    label={t('instances.ram')}
                    type="number"
                    value={form.ramMB}
                    onChange={(e) => setForm({ ...form, ramMB: Number(e.target.value) || 0 })}
                  />
                  <Input
                    label={t('instances.jvm')}
                    placeholder="-Xmn128M -XX:+UseG1GC"
                    value={form.jvmArgs}
                    onChange={(e) => setForm({ ...form, jvmArgs: e.target.value })}
                  />
                </div>
              </div>
              <div className="modal-footer">
                <Button variant="ghost" onClick={() => setShowCreate(false)}>{t('instances.cancel')}</Button>
                <Button variant="primary" loading={saving} onClick={handleSave} disabled={!form.name.trim()}>
                  {editing ? t('instances.save') : t('instances.create_btn')}
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      {/* Dedicated servers modal */}
      <AnimatePresence>
        {showServers && (
          <motion.div
            className="modal-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setShowServers(false)}
          >
            <motion.div
              className="modal"
              style={{ maxWidth: 720, width: '90%' }}
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              transition={{ duration: 0.25 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="modal-header">
                <h2><ServerIcon size={18} /> {t('servers.title')}</h2>
                <button className="modal-close" onClick={() => setShowServers(false)}><X size={16} /></button>
              </div>
              <div className="modal-body">
                {/* Create form */}
                <div style={{ display: 'grid', gap: 8, marginBottom: 16 }}>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Input label={t('servers.name')} value={srvName} onChange={(e) => setSrvName(e.target.value)} placeholder="My server" />
                    <Input label={t('instances.mc_version')} value={srvVersion} onChange={(e) => setSrvVersion(e.target.value)} placeholder="1.21.1" />
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <div className="form-field" style={{ flex: 1 }}>
                      <label className="input-label">{t('servers.flavor')}</label>
                      <div className="loader-pills">
                        {(['paper', 'vanilla'] as const).map((f) => (
                          <button key={f} className={`loader-pill ${srvFlavor === f ? 'loader-pill-active' : ''}`} onClick={() => setSrvFlavor(f)}>{f}</button>
                        ))}
                      </div>
                    </div>
                    <Input label={t('servers.port')} type="number" value={srvPort} onChange={(e) => setSrvPort(Number(e.target.value) || 25565)} />
                    <Input label={t('servers.ram')} type="number" value={srvRam} onChange={(e) => setSrvRam(Number(e.target.value) || 2048)} />
                  </div>
                  <Input label={t('servers.motd')} value={srvMotd} onChange={(e) => setSrvMotd(e.target.value)} />
                  <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
                    <input type="checkbox" checked={srvOnlineMode} onChange={(e) => setSrvOnlineMode(e.target.checked)} />
                    <span className="setting-desc">{t('servers.online_mode')}</span>
                  </label>
                  <Button variant="primary" loading={serverBusy === 'create'} disabled={!srvName.trim() || !srvVersion.trim()} onClick={() => void createServer()}>
                    {t('servers.create_btn')}
                  </Button>
                </div>

                {/* Server list */}
                {serversLoading ? (
                  <p className="install-hint">{t('common.loading')}</p>
                ) : servers.length === 0 ? (
                  <p className="install-hint">{t('servers.empty')}</p>
                ) : (
                  <div style={{ display: 'grid', gap: 10 }}>
                    {servers.map((s) => {
                      const rt = serverStates[s.id]?.state || 'stopped';
                      const log = serverStates[s.id]?.log || [];
                      const running = rt === 'running' || rt === 'starting';
                      return (
                        <div key={s.id} className="card" style={{ padding: 12 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span className={`friend-status ${rt === 'running' ? 'friend-status-on' : 'friend-status-off'}`}>
                              {s.name} · {s.flavor} {s.mcVersion} · :{s.port}
                            </span>
                            <span style={{ flex: 1 }} />
                            {running ? (
                              <Button variant="secondary" size="sm" icon={<Square size={13} />} loading={serverBusy === s.id + ':stop'} onClick={async () => { setServerBusy(s.id + ':stop'); await window.slime.servers.stop(s.id); setServerBusy(null); }}>
                                {t('servers.stop')}
                              </Button>
                            ) : (
                              <Button variant="primary" size="sm" icon={<Play size={13} />} loading={serverBusy === s.id + ':start'} onClick={async () => { setServerBusy(s.id + ':start'); const r = await window.slime.servers.start(s.id) as { ok: boolean; error?: string }; if (!r.ok) add({ type: 'error', title: t('servers.start_failed'), message: r.error || '', duration: 5000 }); setServerBusy(null); }}>
                                {t('servers.start')}
                              </Button>
                            )}
                            <Button variant="ghost" size="sm" icon={<FolderOpen size={14} />} onClick={() => void window.slime.servers.openFolder(s.id)} />
                            <Button
                              variant="ghost"
                              size="sm"
                              className="danger-icon"
                              icon={<Trash2 size={14} />}
                              onClick={async () => {
                                if (!confirm(t('servers.delete_confirm'))) return;
                                const r = await window.slime.servers.delete(s.id) as { ok: boolean; error?: string };
                                if (!r.ok) add({ type: 'error', title: t('servers.delete_failed'), message: r.error || '', duration: 4000 });
                                void reloadServers();
                              }}
                            />
                          </div>
                          {running && (
                            <pre className="console-output" style={{ marginTop: 8, maxHeight: 160, overflow: 'auto', fontSize: 11 }}>
                              {log.slice(-40).join('\n') || t('common.loading')}
                            </pre>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* World backups modal */}
      <AnimatePresence>
        {backupsInst && (
          <motion.div
            className="modal-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setBackupsInst(null)}
          >
            <motion.div
              className="modal"
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              transition={{ duration: 0.25 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="modal-header">
                <h2>{t('backups.title')} — {backupsInst.name}</h2>
                <button className="modal-close" onClick={() => setBackupsInst(null)}><X size={16} /></button>
              </div>
              <div className="modal-body">
                <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                  <Button
                    variant="primary"
                    size="sm"
                    icon={<Archive size={14} />}
                    loading={backupsBusy === 'create'}
                    onClick={() => void createBackup(backupsInst)}
                  >
                    {t('backups.create_now')}
                  </Button>
                  <Button variant="ghost" size="sm" icon={<FolderOpen size={14} />} onClick={() => void window.slime.worldBackups.openFolder(backupsInst.id)}>
                    {t('settings.backups_open')}
                  </Button>
                </div>
                {backupsLoading ? (
                  <p className="install-hint">{t('common.loading')}</p>
                ) : backups.length === 0 ? (
                  <p className="install-hint">{t('backups.empty')}</p>
                ) : (
                  <div style={{ display: 'grid', gap: 8 }}>
                    {backups.map((b) => (
                      <div key={b.id} className="installed-item">
                        <div className="installed-map-icon"><Archive size={17} /></div>
                        <div className="installed-map-info">
                          <strong>{new Date(b.createdAt).toLocaleString()}</strong>
                          <span>{(b.sizeBytes / 1024 / 1024).toFixed(1)} MB · {b.worldCount} {b.worldCount === 1 ? 'world' : 'worlds'}</span>
                        </div>
                        <Button
                          variant="secondary"
                          size="sm"
                          icon={<RotateCcw size={14} />}
                          loading={backupsBusy === b.id}
                          onClick={() => void restoreBackup(b, backupsInst)}
                        >
                          {t('backups.restore')}
                        </Button>
                        <Button variant="ghost" size="sm" icon={<Trash2 size={14} />} onClick={() => void deleteBackup(b, backupsInst)} />
                      </div>
                    ))}
                  </div>
                )}
                <p className="install-hint">{t('backups.hint')}</p>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

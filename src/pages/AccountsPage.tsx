import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { User, Gamepad2, Plus, Trash2, CheckCircle2, AlertTriangle, RefreshCw, CircleUserRound } from 'lucide-react';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { MicrosoftLoginModal } from '@/components/MicrosoftLoginModal';
import { useNotificationStore } from '@/store/notification-store';
import { useAuthStore } from '@/store/auth-store';
import { t } from '@/lib/i18n';
import type { SavedAccount } from '@shared/types';
import './AccountsPage.css';

const MAX_ACCOUNTS = 8;

export function AccountsPage() {
  const [accounts, setAccounts] = useState<SavedAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [nick, setNick] = useState('');
  const [adding, setAdding] = useState(false);
  const [showMsModal, setShowMsModal] = useState(false);
  const { add } = useNotificationStore();
  const { loadCurrent } = useAuthStore();

  const reload = useCallback(async () => {
    const list = await window.slime.accounts.list();
    setAccounts(list as SavedAccount[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const refreshAuth = async () => {
    await loadCurrent();
    await reload();
  };

  const addOffline = async () => {
    if (!nick.trim()) return;
    setAdding(true);
    const res = await window.slime.accounts.addOffline(nick.trim());
    setAdding(false);
    if (res.ok) {
      setNick('');
      add({ type: 'success', title: t('accounts.added_title'), message: t('accounts.added_msg', { nick: nick.trim() }), duration: 3000 });
      await refreshAuth();
    } else {
      add({ type: 'error', title: t('accounts.add_failed_title'), message: res.error || t('accounts.unknown_error'), duration: 4000 });
    }
  };

  const switchAccount = async (id: string) => {
    const res = await window.slime.accounts.setActive(id);
    if (res.ok) {
      add({ type: 'success', title: t('accounts.switched_title'), message: t('accounts.switched_msg'), duration: 3000 });
      await refreshAuth();
    } else {
      add({ type: 'error', title: t('accounts.switch_failed_title'), message: res.error || t('accounts.unknown_error'), duration: 4000 });
    }
  };

  const removeAccount = async (acc: SavedAccount) => {
    const res = await window.slime.accounts.remove(acc.id);
    if (res.ok) {
      add({ type: 'info', title: t('accounts.removed_title'), message: t('accounts.removed_msg', { nick: acc.nick }), duration: 3000 });
      await refreshAuth();
    } else {
      add({ type: 'error', title: t('accounts.remove_failed_title'), message: res.error || t('accounts.unknown_error'), duration: 4000 });
    }
  };

  const full = accounts.length >= MAX_ACCOUNTS;

  return (
    <div className="accounts-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('accounts.title')}</h1>
          <p className="page-subtitle">{t('accounts.subtitle', { max: MAX_ACCOUNTS })}</p>
        </div>
        <div className={`accounts-counter ${full ? 'accounts-counter-full' : ''}`}>
          {accounts.length} / {MAX_ACCOUNTS}
        </div>
      </div>

      <div className="accounts-grid">
        <motion.div
          className="accounts-list"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
        >
          {loading ? (
            <div className="accounts-empty"><RefreshCw size={18} className="accounts-spin" /> {t('accounts.loading')}</div>
          ) : accounts.length === 0 ? (
            <div className="accounts-empty">
              <CircleUserRound size={36} />
              <p>{t('accounts.empty')}</p>
            </div>
          ) : (
            accounts.map((acc) => (
              <div key={acc.id} className={`account-entry ${acc.isActive ? 'account-entry-active' : ''}`}>
                <div className="account-entry-avatar">
                  {acc.kind === 'microsoft' ? <Gamepad2 size={20} /> : <User size={20} />}
                </div>
                <div className="account-entry-info">
                  <div className="account-entry-name">
                    {acc.nick}
                    {acc.isActive && (
                      <span className="account-entry-active-badge"><CheckCircle2 size={13} /> {t('accounts.active')}</span>
                    )}
                  </div>
                  <div className="account-entry-type">
                    {acc.kind === 'microsoft' ? t('accounts.microsoft_online') : t('accounts.offline')}
                  </div>
                </div>
                <div className="account-entry-actions">
                  {!acc.isActive && (
                    <Button variant="secondary" size="sm" onClick={() => void switchAccount(acc.id)}>{t('accounts.switch')}</Button>
                  )}
                  <Button variant="danger" size="sm" onClick={() => void removeAccount(acc)}>
                    <Trash2 size={14} />
                  </Button>
                </div>
              </div>
            ))
          )}
        </motion.div>

        <motion.div
          className="accounts-add"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.05 }}
        >
          <h3>{t('accounts.add_title')}</h3>
          {full ? (
            <div className="accounts-limit-note">
              <AlertTriangle size={16} />
              {t('accounts.limit_reached', { max: MAX_ACCOUNTS })}
            </div>
          ) : (
            <>
              <div className="accounts-add-offline">
                <Input
                  placeholder={t('accounts.nick_placeholder')}
                  value={nick}
                  onChange={(e) => setNick(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void addOffline(); }}
                  maxLength={24}
                  disabled={adding}
                />
                <Button variant="primary" icon={<Plus size={16} />} onClick={() => void addOffline()} disabled={adding || !nick.trim()}>
                  {adding ? t('accounts.adding') : t('accounts.add_offline')}
                </Button>
              </div>
              <div className="accounts-divider"><span>{t('accounts.or')}</span></div>
              <Button variant="secondary" icon={<Gamepad2 size={16} />} onClick={() => setShowMsModal(true)} disabled={full}>
                {t('accounts.link_ms')}
              </Button>
            </>
          )}
          <p className="accounts-hint">
            {t('accounts.hint')}
          </p>
        </motion.div>
      </div>

      <MicrosoftLoginModal
        open={showMsModal}
        onClose={() => setShowMsModal(false)}
        onSuccess={() => void refreshAuth()}
      />
    </div>
  );
}
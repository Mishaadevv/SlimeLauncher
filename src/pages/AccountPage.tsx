import { useState } from 'react';
import { motion } from 'framer-motion';
import { User, Mail, Calendar, Play, Heart, Boxes, LogOut, Pencil, Check, X, Gamepad2, Lock } from 'lucide-react';
import { useAuthStore } from '@/store/auth-store';
import { useInstanceStore } from '@/store/instance-store';
import { useNavigationStore } from '@/store/navigation-store';
import { useNotificationStore } from '@/store/notification-store';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { AppIcon } from '@/components/AppIcon';
import { MicrosoftLoginModal } from '@/components/MicrosoftLoginModal';
import { MsAccountAvatar } from '@/components/MsAccountAvatar';
import { t } from '@/lib/i18n';
import './AccountPage.css';

export function AccountPage() {
  const { user, activeMicrosoft, logout, updateProfile, changePassword, microsoftAccounts, loadMicrosoft, logoutMicrosoft, setActiveMicrosoft } = useAuthStore();
  const { instances } = useInstanceStore();
  const { navigate } = useNavigationStore();
  const { add } = useNotificationStore();
  const [editingName, setEditingName] = useState(false);
  const [newName, setNewName] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [showMsModal, setShowMsModal] = useState(false);

  if (!user && !activeMicrosoft) {
    return (
      <div className="account-page">
        <div className="account-empty">
          <AppIcon size={64} />
          <h2>{t('account.not_signed_title')}</h2>
          <p>{t('account.not_signed_desc')}</p>
          <Button variant="primary" onClick={() => navigate('login')}>{t('account.sign_in_btn')}</Button>
        </div>
      </div>
    );
  }

  const profileName = user?.username || activeMicrosoft?.username || 'Account';

  const saveName = async () => {
    if (!newName.trim()) return;
    const res = await updateProfile({ username: newName.trim() });
    if (res.ok) {
      add({ type: 'success', title: t('account.profile_updated'), message: t('account.username_changed'), duration: 3000 });
      setEditingName(false);
    } else {
      add({ type: 'error', title: t('account.update_failed'), message: res.error || t('home.launch_error_unknown'), duration: 4000 });
    }
  };

  const savePassword = async () => {
    if (newPw !== confirmPw) {
      add({ type: 'error', title: t('account.pw_mismatch'), message: t('account.pw_mismatch_desc'), duration: 4000 });
      return;
    }
    const res = await changePassword(currentPw, newPw);
    if (res.ok) {
      add({ type: 'success', title: t('account.pw_changed'), message: t('account.pw_changed_desc'), duration: 3000 });
      setShowPassword(false); setCurrentPw(''); setNewPw(''); setConfirmPw('');
    } else {
      add({ type: 'error', title: t('account.pw_change_failed'), message: res.error || t('home.launch_error_unknown'), duration: 4000 });
    }
  };

  const handleLogout = async () => {
    await logout();
    add({ type: 'info', title: t('account.logged_out'), message: t('account.logged_out_desc'), duration: 3000 });
    navigate('home');
  };

  return (
    <div className="account-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('account.profile_title')}</h1>
          <p className="page-subtitle">{t('account.profile_subtitle')}</p>
        </div>
        {user && (
          <Button variant="danger" icon={<LogOut size={16} />} onClick={handleLogout}>{t('account.logout_btn2')}</Button>
        )}
      </div>

      <div className="account-grid">
        <motion.div
          className="account-profile-card"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
        >
          <div className="account-avatar-large">
            {user?.avatar ? (
              <img src={user.avatar} alt="" />
            ) : activeMicrosoft ? (
              <MsAccountAvatar active size={76} />
            ) : (
              <User size={40} />
            )}
          </div>
          {activeMicrosoft && !user && (
            <span className="skin-badge" style={{ marginBottom: 8 }}>{t('account.microsoft_badge')}</span>
          )}
          <div className="account-name-row">
            {editingName ? (
              <>
                <Input value={newName} onChange={(e) => setNewName(e.target.value)} autoFocus />
                <Button variant="primary" size="sm" icon={<Check size={14} />} onClick={saveName} />
                <Button variant="ghost" size="sm" icon={<X size={14} />} onClick={() => setEditingName(false)} />
              </>
            ) : (
              <>
                <h2 className="account-name">{profileName}</h2>
                {user && (
                  <button className="icon-btn-sm" onClick={() => { setNewName(user.username); setEditingName(true); }}>
                    <Pencil size={14} />
                  </button>
                )}
              </>
            )}
          </div>
          {user && <div className="account-email"><Mail size={14} /> {user.email}</div>}

          <div className="account-stats">
            {user && (
              <>
                <div className="account-stat">
                  <Calendar size={16} />
                  <div>
                    <div className="account-stat-value">{new Date(user.createdAt).toLocaleDateString()}</div>
                    <div className="account-stat-label">{t('account.joined_label')}</div>
                  </div>
                </div>
                <div className="account-stat">
                  <Play size={16} />
                  <div>
                    <div className="account-stat-value">{user.launchCount}</div>
                    <div className="account-stat-label">{t('account.launches_label')}</div>
                  </div>
                </div>
              </>
            )}
            <div className="account-stat">
              <Boxes size={16} />
              <div>
                <div className="account-stat-value">{instances.length}</div>
                <div className="account-stat-label">{t('account.instances_label')}</div>
              </div>
            </div>
          </div>
        </motion.div>

        <motion.div
          className="account-section"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.05 }}
        >
          <div className="account-section-header">
            <h3><Gamepad2 size={16} /> {t('account.minecraft_accounts_title')}</h3>
            <Button variant="secondary" size="sm" onClick={() => setShowMsModal(true)}>{t('account.link_ms_btn')}</Button>
          </div>
          {microsoftAccounts.length === 0 ? (
            <div className="account-ms-empty">
              <p>{t('account.no_ms_title')}</p>
              <p className="account-ms-hint">{t('account.no_ms_hint2')}</p>
            </div>
          ) : (
            <div className="account-ms-list">
              {microsoftAccounts.map((acc) => (
                <div key={acc.id} className="account-ms-item">
                  <div className="ms-avatar"><Gamepad2 size={18} /></div>
                  <div className="ms-info">
                    <div className="ms-name">{acc.username}</div>
                    <div className="ms-uuid">{acc.uuid}</div>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => logoutMicrosoft(acc.id)}>Unlink</Button>
                </div>
              ))}
            </div>
          )}
        </motion.div>

        {user && (
          <motion.div
            className="account-section"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: 0.1 }}
          >
            <div className="account-section-header">
              <h3><Lock size={16} /> {t('account.security_title')}</h3>
              {!showPassword && (
                <Button variant="secondary" size="sm" onClick={() => setShowPassword(true)}>{t('account.change_pw_btn')}</Button>
              )}
            </div>
            {showPassword && (
              <div className="password-form">
                <Input label={t('account.current_pw')} type="password" value={currentPw} onChange={(e) => setCurrentPw(e.target.value)} />
                <Input label={t('account.new_pw')} type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} />
                <Input label={t('account.confirm_new_pw')} type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} />
                <div className="password-actions">
                  <Button variant="ghost" size="sm" onClick={() => setShowPassword(false)}>{t('account.cancel_btn')}</Button>
                  <Button variant="primary" size="sm" onClick={savePassword}>{t('account.save_btn')}</Button>
                </div>
              </div>
            )}
          </motion.div>
        )}

        {user && (
          <motion.div
            className="account-section"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: 0.15 }}
          >
            <div className="account-section-header">
              <h3><Heart size={16} /> {t('account.favorites_title')}</h3>
            </div>
            <div className="account-ms-empty">
              <p>{t('account.no_fav_title')}</p>
              <p className="account-ms-hint">{t('account.no_fav_hint2')}</p>
            </div>
          </motion.div>
        )}
      </div>

      <MicrosoftLoginModal
        open={showMsModal}
        onClose={() => setShowMsModal(false)}
        onSuccess={() => void loadMicrosoft()}
      />
    </div>
  );
}

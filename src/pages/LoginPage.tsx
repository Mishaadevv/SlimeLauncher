import { useState } from 'react';
import { motion } from 'framer-motion';
import { User, Gamepad2, ArrowRight } from 'lucide-react';
import { useNavigationStore } from '@/store/navigation-store';
import { useNotificationStore } from '@/store/notification-store';
import { useAuthStore } from '@/store/auth-store';
import { Input } from '@/components/Input';
import { Button } from '@/components/Button';
import { AppIcon } from '@/components/AppIcon';
import { t } from '@/lib/i18n';
import './AuthPages.css';

export function LoginPage() {
  const { navigate } = useNavigationStore();
  const { add } = useNotificationStore();
  const { register, loginMicrosoft, loading } = useAuthStore();
  const [mode, setMode] = useState<'choose' | 'offline'>('choose');
  const [username, setUsername] = useState('');
  const [loadingMs, setLoadingMs] = useState(false);

  const handleOffline = async () => {
    if (!username.trim()) {
      add({ type: 'warning', title: 'Enter a username', message: 'Please enter a display name.', duration: 3000 });
      return;
    }
    const cleanName = username.trim().replace(/[^a-zA-Z0-9_-]/g, '');
    if (cleanName.length < 1) {
      add({ type: 'warning', title: 'Invalid username', message: 'Use letters, numbers, _ or -', duration: 3000 });
      return;
    }
    const res = await register(cleanName, `${cleanName}@offline.local`, 'offline');
    if (res.ok) {
      add({ type: 'success', title: 'Welcome!', message: `Signed in as ${cleanName}`, duration: 3000 });
      navigate('home');
    } else {
      add({ type: 'error', title: 'Login failed', message: res.error || 'Could not sign in.', duration: 4000 });
    }
  };

  const handleMicrosoft = async () => {
    setLoadingMs(true);
    try {
      const res = await loginMicrosoft();
      if (res.ok) {
        add({ type: 'success', title: 'Microsoft linked', message: 'Your account is connected.', duration: 3000 });
        navigate('home');
      }
      // If not ok, notification was already sent by the handler
    } catch (e) {
      add({ type: 'error', title: 'Microsoft login failed', message: String(e), duration: 5000 });
    } finally {
      setLoadingMs(false);
    }
  };

  return (
    <div className="auth-page">
      <motion.div
        className="auth-card"
        initial={{ opacity: 0, y: 20, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="auth-logo">
          <AppIcon size={56} />
        </div>
        <h1 className="auth-title">{t('login.title')}</h1>
        <p className="auth-subtitle">{t('login.subtitle')}</p>

        {mode === 'choose' ? (
          <div className="auth-methods">
            <button className="auth-method" onClick={() => setMode('offline')}>
              <div className="auth-method-icon"><User size={24} /></div>
              <div className="auth-method-info">
                <h3>{t('login.offline')}</h3>
                <p>{t('login.offline_desc')}</p>
              </div>
              <ArrowRight size={18} className="auth-method-arrow" />
            </button>
            <button className="auth-method" onClick={handleMicrosoft} disabled={loadingMs}>
              <div className="auth-method-icon"><Gamepad2 size={24} /></div>
              <div className="auth-method-info">
                <h3>{t('login.microsoft')}</h3>
                <p>{t('login.microsoft_desc')}</p>
              </div>
              <ArrowRight size={18} className="auth-method-arrow" />
            </button>
          </div>
        ) : (
          <div className="auth-form">
            <Input
              label={t('login.display_name')}
              placeholder="Steve"
              icon={<User size={16} />}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
            />
            <Button variant="primary" size="lg" fullWidth loading={loading} onClick={handleOffline} icon={<User size={16} />}>
              {t('login.start')}
            </Button>
            <button className="auth-link" onClick={() => setMode('choose')} style={{ marginTop: 8, fontSize: 13 }}>
              {t('login.back')}
            </button>
          </div>
        )}

        <div className="auth-footer">
          <span>{t('login.has_account')}</span>
          <button className="auth-link" onClick={() => navigate('register')}>{t('login.create')}</button>
        </div>
      </motion.div>
    </div>
  );
}

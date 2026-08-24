import { useState } from 'react';
import { motion } from 'framer-motion';
import { User, Lock, Mail, Check, ArrowRight } from 'lucide-react';
import { useAuthStore } from '@/store/auth-store';
import { useNavigationStore } from '@/store/navigation-store';
import { useNotificationStore } from '@/store/notification-store';
import { Input } from '@/components/Input';
import { Button } from '@/components/Button';
import { AppIcon } from '@/components/AppIcon';
import { t } from '@/lib/i18n';
import './AuthPages.css';

export function RegisterPage() {
  const { register, loading } = useAuthStore();
  const { navigate } = useNavigationStore();
  const { add } = useNotificationStore();
  const [mode, setMode] = useState<'choose' | 'form'>('choose');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);

  const strength = Math.min(
    (password.length >= 8 ? 1 : 0) +
    (/[A-Z]/.test(password) ? 1 : 0) +
    (/[0-9]/.test(password) ? 1 : 0) +
    (/[^A-Za-z0-9]/.test(password) ? 1 : 0),
    4
  );

  const strengthLabels = ['', t('register.strength_weak'), t('register.strength_fair'), t('register.strength_good'), t('register.strength_strong')];
  const strengthColors = ['', '#f87171', '#fbbf24', '#60a5fa', '#4ade80'];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!username || !email || !password) { setError(t('register.fill_all')); return; }
    if (password !== confirm) { setError(t('register.pw_mismatch')); return; }
    if (password.length < 4) { setError(t('register.pw_short')); return; }

    const res = await register(username, email, password);
    if (res.ok) {
      add({ type: 'success', title: t('register.welcome'), message: t('register.account_created'), duration: 3000 });
      navigate('home');
    } else {
      setError(res.error || t('register.registration_failed'));
    }
  };

  const handleOffline = async () => {
    if (!username.trim()) return;
    const cleanName = username.trim().replace(/[^a-zA-Z0-9_\-]/g, '');
    if (cleanName.length < 1) {
      add({ type: 'warning', title: t('register.invalid_username'), message: t('register.invalid_username_desc'), duration: 3000 });
      return;
    }
    const res = await register(cleanName, `${cleanName}@offline.local`, 'offline');
    if (res.ok) {
      add({ type: 'success', title: t('register.welcome'), message: t('register.signed_in_as', { name: cleanName }), duration: 3000 });
      navigate('home');
    } else {
      add({ type: 'error', title: t('register.login_failed'), message: res.error || t('register.sign_in_failed'), duration: 4000 });
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
        <h1 className="auth-title">{mode === 'choose' ? t('register.title') : t('register.create_title')}</h1>
        <p className="auth-subtitle">{mode === 'choose' ? t('register.subtitle') : t('register.join')}</p>

        {mode === 'choose' ? (
          <div className="auth-methods">
            <button className="auth-method" onClick={() => { setMode('form'); }}>
              <div className="auth-method-icon"><Mail size={24} /></div>
              <div className="auth-method-info">
                <h3>{t('register.email_account')}</h3>
                <p>{t('register.email_desc')}</p>
              </div>
              <ArrowRight size={18} className="auth-method-arrow" />
            </button>
            <button className="auth-method" onClick={() => { setUsername(''); setMode('form'); }}>
              <div className="auth-method-icon"><User size={24} /></div>
              <div className="auth-method-info">
                <h3>{t('register.offline')}</h3>
                <p>{t('register.offline_desc')}</p>
              </div>
              <ArrowRight size={18} className="auth-method-arrow" />
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="auth-form">
            <Input
              label={t('register.username')}
              placeholder="Steve"
              icon={<User size={16} />}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
            <Input
              label={t('register.email')}
              type="email"
              placeholder="you@example.com"
              icon={<Mail size={16} />}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Input
              label={t('register.password')}
              type="password"
              placeholder={t('register.password_placeholder')}
              icon={<Lock size={16} />}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {password.length > 0 && (
              <div className="strength">
                <div className="strength-bars">
                  {[1, 2, 3, 4].map((i) => (
                    <div key={i} className="strength-bar" style={{ background: i <= strength ? strengthColors[strength] : 'var(--bg-3)' }} />
                  ))}
                </div>
                <span className="strength-label" style={{ color: strengthColors[strength] }}>{strengthLabels[strength]}</span>
              </div>
            )}
            <Input
              label={t('register.confirm')}
              type="password"
              placeholder={t('register.confirm_placeholder')}
              icon={<Lock size={16} />}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
            {error && <div className="auth-error">{error}</div>}
            <Button type="submit" variant="primary" size="lg" fullWidth loading={loading} icon={<Check size={16} />}>
              {t('register.create_btn')}
            </Button>
            <button type="button" className="auth-link" onClick={() => setMode('choose')} style={{ marginTop: 4, fontSize: 13 }}>
              {t('register.back')}
            </button>
          </form>
        )}

        <div className="auth-footer">
          <span>{t('register.has_account')}</span>
          <button className="auth-link" onClick={() => navigate('login')}>{t('register.sign_in')}</button>
        </div>
      </motion.div>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Gamepad2, ExternalLink, X, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/Button';
import { t } from '@/lib/i18n';

interface DeviceInfo {
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  device_code: string;
  expires_in: number;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export function MicrosoftLoginModal({ open, onClose, onSuccess }: Props) {
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  const [state, setState] = useState<'starting' | 'waiting' | 'finishing' | 'error'>('starting');
  const [error, setError] = useState<string | null>(null);
  // The parent may re-render (and pass fresh inline callbacks) while the modal
  // is open; guard with a ref so the device-code flow only starts once per open.
  const runIdRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    const runId = ++runIdRef.current;
    let cancelled = false;
    setDevice(null);
    setState('starting');
    setError(null);

    (async () => {
      try {
        const res = await window.slime.ms.deviceCode();
        if (cancelled || runId !== runIdRef.current) return;
        if (!res.ok || !res.device) {
          setState('error');
          setError(res.error || 'Could not start Microsoft sign-in.');
          return;
        }
        setDevice(res.device as DeviceInfo);
        setState('waiting');
        // Poll until the user completes authorization in the browser.
        const done = await window.slime.ms.complete((res.device as DeviceInfo).device_code);
        if (cancelled || runId !== runIdRef.current) return;
        if (done.ok) {
          setState('finishing');
          onSuccess();
          onClose();
        } else {
          setState('error');
          setError(done.error || 'Sign-in was not completed.');
        }
      } catch (e) {
        if (cancelled || runId !== runIdRef.current) return;
        setState('error');
        setError(String(e));
      }
    })();

    return () => { cancelled = true; };
    // Intentionally only re-run when the modal is (re)opened. Parent re-renders
    // with fresh onClose/onSuccess identities must NOT restart the flow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="modal-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={() => { if (state !== 'waiting' && state !== 'finishing') onClose(); }}
        >
          <motion.div
            className="modal ms-login-modal"
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ duration: 0.25 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h2><Gamepad2 size={18} /> {t('ms_login.title')}</h2>
              <button className="modal-close" onClick={onClose}><X size={16} /></button>
            </div>
            <div className="modal-body">
              {state === 'starting' && (
                <div className="ms-login-state">
                  <Loader2 size={26} className="ms-spin" />
                  <span>{t('ms_login.starting')}</span>
                </div>
              )}

              {(state === 'waiting' || state === 'finishing') && device && (
                <>
                  <p className="ms-login-step">
                    {t('ms_login.step1')}
                  </p>
                  <a
                    className="ms-login-link"
                    href={device.verification_uri_complete || device.verification_uri}
                    onClick={(e) => { e.preventDefault(); window.open(device.verification_uri_complete || device.verification_uri, '_blank'); }}
                  >
                    {device.verification_uri} <ExternalLink size={14} />
                  </a>
                  <p className="ms-login-step">{t('ms_login.step2')}</p>
                  <div className="ms-login-code">{device.user_code}</div>
                  {state === 'finishing' ? (
                    <div className="ms-login-state">
                      <CheckCircle2 size={22} className="ms-ok" />
                      <span>{t('ms_login.finishing')}</span>
                    </div>
                  ) : (
                    <div className="ms-login-state">
                      <Loader2 size={20} className="ms-spin" />
                      <span>{t('ms_login.waiting')}</span>
                    </div>
                  )}
                </>
              )}

              {state === 'error' && (
                <div className="ms-login-error">
                  <AlertTriangle size={22} />
                  <span>{error || t('ms_login.error_fallback')}</span>
                </div>
              )}
            </div>
            <div className="modal-footer">
              {state === 'error' ? (
                <Button variant="primary" onClick={onClose}>{t('ms_login.close')}</Button>
              ) : (
                <Button variant="ghost" onClick={onClose} disabled={state === 'finishing'}>{t('ms_login.cancel')}</Button>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

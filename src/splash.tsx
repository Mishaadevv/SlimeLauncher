import React from 'react';
import ReactDOM from 'react-dom/client';
import { motion } from 'framer-motion';
import './splash.css';

function Splash() {
  return (
    <div className="splash">
      <div className="splash-bg" />
      <motion.div
        className="splash-content"
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="splash-logo">
          <svg width="72" height="72" viewBox="0 0 100 100">
            <defs>
              <radialGradient id="sg" cx="40%" cy="35%" r="70%">
                <stop offset="0%" stopColor="#4ade80" stopOpacity="0.95" />
                <stop offset="60%" stopColor="#22c55e" stopOpacity="0.85" />
                <stop offset="100%" stopColor="#16a34a" stopOpacity="0.7" />
              </radialGradient>
              <filter id="sb" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="1.2" />
              </filter>
            </defs>
            <motion.path
              d="M50 12 C72 12 88 28 88 50 C88 64 80 76 68 82 C60 86 52 88 50 88 C48 88 40 86 32 82 C20 76 12 64 12 50 C12 28 28 12 50 12 Z"
              fill="url(#sg)"
              filter="url(#sb)"
              animate={{
                d: [
                  'M50 12 C72 12 88 28 88 50 C88 64 80 76 68 82 C60 86 52 88 50 88 C48 88 40 86 32 82 C20 76 12 64 12 50 C12 28 28 12 50 12 Z',
                  'M50 14 C74 14 90 30 86 52 C84 66 78 78 66 84 C58 88 52 86 50 86 C48 86 42 88 34 84 C22 78 14 66 14 50 C14 28 26 14 50 14 Z',
                  'M50 12 C72 12 88 28 88 50 C88 64 80 76 68 82 C60 86 52 88 50 88 C48 88 40 86 32 82 C20 76 12 64 12 50 C12 28 28 12 50 12 Z',
                ],
              }}
              transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
            />
            <ellipse cx="38" cy="32" rx="14" ry="9" fill="white" opacity="0.18" />
            <ellipse cx="38" cy="52" rx="5" ry="7" fill="#0a0e0a" opacity="0.85" />
            <ellipse cx="62" cy="52" rx="5" ry="7" fill="#0a0e0a" opacity="0.85" />
            <ellipse cx="39.5" cy="50" rx="1.6" ry="2" fill="white" opacity="0.7" />
            <ellipse cx="63.5" cy="50" rx="1.6" ry="2" fill="white" opacity="0.7" />
            <path d="M42 66 Q50 70 58 66" stroke="#0a0e0a" strokeWidth="2" strokeLinecap="round" fill="none" opacity="0.6" />
          </svg>
        </div>
        <motion.h1
          className="splash-title"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2, duration: 0.4 }}
        >
          Slime<span>Launcher</span>
        </motion.h1>
        <motion.p
          className="splash-sub"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.4, duration: 0.4 }}
        >
          Loading your world...
        </motion.p>
        <motion.div
          className="splash-bar"
          initial={{ scaleX: 0 }}
          animate={{ scaleX: [0, 0.4, 0.7, 1] }}
          transition={{ duration: 1.6, ease: 'easeInOut' }}
        />
      </motion.div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('splash-root')!).render(
  <React.StrictMode>
    <Splash />
  </React.StrictMode>
);

import { useEffect, useState } from 'react';
import { Minus, Square, X, Copy } from 'lucide-react';
import { AppIcon } from './AppIcon';
import './TitleBar.css';

export function TitleBar() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    window.slime.app.isMaximized().then(setMaximized);
    const unsub = window.slime.app.onMaximizeChange(setMaximized);
    return () => { unsub(); };
  }, []);

  return (
    <div className="titlebar" onDoubleClick={() => window.slime.app.maximize()}>
      <div className="titlebar-left">
        <AppIcon size={18} />
        <span className="titlebar-title">SlimeLauncher</span>
      </div>
      <div className="titlebar-controls">
        <button className="titlebar-btn" onClick={() => window.slime.app.minimize()} aria-label="Minimize">
          <Minus size={14} />
        </button>
        <button className="titlebar-btn" onClick={() => window.slime.app.maximize()} aria-label="Maximize">
          {maximized ? <Copy size={12} /> : <Square size={12} />}
        </button>
        <button className="titlebar-btn titlebar-close" onClick={() => window.slime.app.close()} aria-label="Close">
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

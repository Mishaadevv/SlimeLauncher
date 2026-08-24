import { useCallback, useRef, useState } from 'react';
import { Keyboard } from 'lucide-react';
import './HotkeyInput.css';

// Normalizes a KeyboardEvent.key into the accelerator syntax Electron's
// globalShortcut understands (e.g. Ctrl+Shift+F9, F8, Alt+Space).
const MODIFIERS: Record<string, string> = {
  Control: 'Ctrl',
  Alt: 'Alt',
  Shift: 'Shift',
  Meta: 'Super',
};

const KEY_NAMES: Record<string, string> = {
  ' ': 'Space',
  Escape: 'Esc',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Insert: 'Insert',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  Enter: 'Enter',
  Return: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  CapsLock: 'Capslock',
  NumLock: 'Numlock',
  ScrollLock: 'Scrolllock',
  PrintScreen: 'PrintScreen',
};

function normalizeKey(key: string): string | null {
  if (/^[a-z]$/i.test(key)) return key.toUpperCase();
  if (/^[0-9]$/.test(key)) return key;
  if (/^F([1-9]|1[0-9]|2[0-4])$/i.test(key)) return key.toUpperCase();
  return KEY_NAMES[key] ?? null;
}

function comboFromEvent(e: React.KeyboardEvent): string | null {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Super');
  if (MODIFIERS[e.key]) return null; // modifier alone — keep listening
  const key = normalizeKey(e.key);
  if (!key) return null;
  parts.push(key);
  return parts.join('+');
}

interface HotkeyInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}

export function HotkeyInput({ value, onChange, placeholder, className, disabled }: HotkeyInputProps) {
  const [listening, setListening] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);

  const start = useCallback(() => {
    if (disabled) return;
    setListening(true);
    requestAnimationFrame(() => ref.current?.focus());
  }, [disabled]);

  const cancel = useCallback(() => setListening(false), []);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      cancel();
      return;
    }
    if (e.key === 'Backspace' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      onChange('');
      cancel();
      return;
    }
    const combo = comboFromEvent(e);
    if (!combo) return;
    onChange(combo);
    cancel();
  }, [cancel, onChange]);

  return (
    <button
      ref={ref}
      type="button"
      className={`hotkey-input ${listening ? 'hotkey-input-listening' : ''} ${className || ''}`}
      onClick={start}
      onKeyDown={listening ? onKeyDown : undefined}
      onBlur={cancel}
      disabled={disabled}
      title={listening ? undefined : (value || placeholder || '')}
    >
      <Keyboard size={14} className="hotkey-input-icon" />
      <span className={`hotkey-input-label ${!value && !listening ? 'hotkey-input-empty' : ''}`}>
        {listening ? '…' : (value || placeholder || '—')}
      </span>
      {listening && <span className="hotkey-input-dot" />}
    </button>
  );
}

import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import './Input.css';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string | null;
  hint?: string;
  icon?: React.ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, hint, icon, className, ...rest }, ref) => (
    <div className={`input-wrap ${className || ''}`}>
      {label && <label className="input-label">{label}</label>}
      <div className={`input-box ${error ? 'input-error' : ''}`}>
        {icon && <span className="input-icon">{icon}</span>}
        <input ref={ref} className="input" {...rest} />
      </div>
      {error && <span className="input-error-text">{error}</span>}
      {!error && hint && <span className="input-hint">{hint}</span>}
    </div>
  )
);
Input.displayName = 'Input';

interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string | null;
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(
  ({ label, error, className, ...rest }, ref) => (
    <div className={`input-wrap ${className || ''}`}>
      {label && <label className="input-label">{label}</label>}
      <div className={`input-box ${error ? 'input-error' : ''}`}>
        <textarea ref={ref} className="input textarea" {...rest} />
      </div>
      {error && <span className="input-error-text">{error}</span>}
    </div>
  )
);
TextArea.displayName = 'TextArea';

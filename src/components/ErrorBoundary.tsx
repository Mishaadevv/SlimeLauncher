import { Component, type ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import { t } from '@/lib/i18n';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches render errors so a single broken page shows a recoverable fallback
 * instead of unmounting the entire app (blank UI). "Try again" re-renders the
 * page; if the error persists it keeps showing the fallback.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: unknown) {
    console.error('Page render error', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="error-boundary">
          <h2>{t('error.boundary_title')}</h2>
          <p>{String(this.state.error.message || this.state.error)}</p>
          <button
            className="error-boundary-retry"
            onClick={() => this.setState({ error: null })}
          >
            <RefreshCw size={14} /> {t('common.try_again')}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

import { useEffect } from 'react';
import { Download, Pause, Play, RotateCcw, X, Trash2 } from 'lucide-react';
import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { useDownloadStore } from '@/store/download-store';
import { t } from '@/lib/i18n';
import type { DownloadTask } from '@shared/types';
import './CatalogPages.css';

function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export function DownloadsPage() {
  const { tasks, load, pause, resume, cancel, retry, clearCompleted, setTasks } = useDownloadStore();
  const STATUS_LABEL: Record<string, string> = {
    downloading: t('downloads.status_downloading'),
    paused: t('downloads.status_paused'),
    completed: t('downloads.status_completed'),
    error: t('downloads.status_failed'),
    cancelled: t('downloads.status_cancelled'),
    queued: t('downloads.status_queued'),
  };

  useEffect(() => {
    void load();
    const unsub = window.slime.dl.onProgress((t) => {
      setTasks(t as DownloadTask[]);
    });
    return () => unsub();
  }, [load, setTasks]);

  const active = tasks.filter((t) => t.status === 'downloading' || t.status === 'queued');
  const finished = tasks.filter((t) => t.status === 'completed' || t.status === 'error' || t.status === 'cancelled');

  return (
    <div className="catalog-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('downloads.title2')}</h1>
          <p className="page-subtitle">{t('downloads.subtitle2')}</p>
        </div>
      </div>

      {tasks.length === 0 ? (
        <EmptyState title={t('downloads.all_clear')} description={t('downloads.all_clear_desc')} icon={<Download size={28} />} />
      ) : (
        <>
          {active.length > 0 && (
            <section className="installed-section">
              <div className="section-heading">
                <div>
                  <h2>{t('downloads.active')}</h2>
                  <p>{active.length === 1 ? t('downloads.active_count', { count: active.length }) : t('downloads.active_count_plural', { count: active.length })}</p>
                </div>
              </div>
              <div className="download-list">
                {active.map((task) => {
                  const progress = task.totalBytes ? (task.downloadedBytes / task.totalBytes) * 100 : 0;
                  return (
                    <div className="card download-row" key={task.id}>
                      <div className="download-icon"><Download size={18} /></div>
                      <div className="download-info">
                        <strong>{task.name}</strong>
                        <span>{STATUS_LABEL[task.status] || task.status} · {Math.round(progress)}% · {formatBytes(task.downloadedBytes)} / {formatBytes(task.totalBytes)}</span>
                        <div className="progress">
                          <i style={{ width: `${progress}%` }} />
                        </div>
                      </div>
                      <div className="download-actions">
                        <Button variant="ghost" size="sm" icon={task.status === 'downloading' ? <Pause size={15} /> : <Play size={15} />} onClick={() => task.status === 'downloading' ? pause(task.id) : resume(task.id)} />
                        <Button variant="ghost" size="sm" icon={<X size={15} />} onClick={() => cancel(task.id)} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {finished.length > 0 && (
            <section className="installed-section">
              <div className="section-heading">
                <div>
                  <h2>{t('downloads.completed')}</h2>
                  <p>{finished.length === 1 ? t('downloads.finished_count', { count: finished.length }) : t('downloads.finished_count_plural', { count: finished.length })}</p>
                </div>
                <Button variant="ghost" size="sm" icon={<Trash2 size={14} />} onClick={() => clearCompleted()}>
                  {t('downloads.clear_completed')}
                </Button>
              </div>
              <div className="download-list">
                {finished.map((task) => {
                  const progress = task.totalBytes ? (task.downloadedBytes / task.totalBytes) * 100 : 0;
                  return (
                    <div className="card download-row" key={task.id}>
                      <div className="download-icon">
                        {task.status === 'completed' ? <Download size={18} /> : <X size={18} />}
                      </div>
                      <div className="download-info">
                        <strong>{task.name}</strong>
                        <span>{STATUS_LABEL[task.status] || task.status} · {formatBytes(task.totalBytes)}</span>
                        <div className="progress">
                          <i style={{ width: task.status === 'completed' ? '100%' : `${progress}%` }} />
                        </div>
                      </div>
                      <div className="download-actions">
                        {(task.status === 'error' || task.status === 'cancelled') && (
                          <Button variant="ghost" size="sm" icon={<RotateCcw size={15} />} onClick={() => retry(task.id)} />
                        )}
                        <Button variant="ghost" size="sm" icon={<X size={15} />} onClick={() => cancel(task.id)} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

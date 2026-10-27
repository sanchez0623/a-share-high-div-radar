import { useEffect, type ReactNode } from 'react';
import { Check, X } from 'lucide-react';
import type { ResearchLevel, SignalStatus } from '../../shared/types.ts';

export function LevelBadge({ level }: { level: ResearchLevel }) {
  return <span className={`level-badge level-${level.toLowerCase()}`}>{level}</span>;
}

export function SignalPill({ status, children }: { status: SignalStatus; children: ReactNode }) {
  return <span className={`signal-pill signal-${status}`}>{children}</span>;
}

export function SectionHeading({
  eyebrow,
  title,
  aside,
}: {
  eyebrow?: string;
  title: string;
  aside?: ReactNode;
}) {
  return (
    <div className="section-heading">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h2>{title}</h2>
      </div>
      {aside}
    </div>
  );
}

export function Modal({
  title,
  eyebrow,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  eyebrow?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-header">
          <div>
            {eyebrow && <span className="eyebrow">{eyebrow}</span>}
            <h2>{title}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭弹窗" autoFocus>
            <X size={19} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

export function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  useEffect(() => {
    const timer = window.setTimeout(onClose, 3200);
    return () => window.clearTimeout(timer);
  }, [message, onClose]);

  return (
    <div className="toast" role="status">
      <span className="toast-icon"><Check size={15} /></span>
      {message}
      <button onClick={onClose} aria-label="关闭提示"><X size={15} /></button>
    </div>
  );
}

export function LoadingScreen() {
  return (
    <main className="loading-screen">
      <div className="loading-mark">息</div>
      <p>正在铺开今日研究图谱</p>
      <span>连接指标引擎与组合账本…</span>
    </main>
  );
}

export function ErrorScreen({ message, retry }: { message: string; retry: () => void }) {
  return (
    <main className="loading-screen">
      <div className="loading-mark error-mark">!</div>
      <p>研究台暂时无法连接</p>
      <span>{message}</span>
      <button className="button button-primary" onClick={retry}>重新连接</button>
    </main>
  );
}

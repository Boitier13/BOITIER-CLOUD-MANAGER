import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

interface ModalProps {
  title: string;
  description?: string;
  icon?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  labelledBy?: string;
}

export function Modal({
  title,
  description,
  icon,
  onClose,
  children,
  footer,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = `modal-${title.replace(/\s+/g, '-').toLowerCase()}`;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    const timer = window.setTimeout(() => {
      const target = panelRef.current?.querySelector<HTMLElement>(
        'input, select, textarea, button[data-autofocus]',
      );
      target?.focus();
    }, 30);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      window.clearTimeout(timer);
    };
  }, [onClose]);

  return (
    <div
      className="overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={panelRef}
      >
        <div className="modal__head">
          {icon ? <span className="modal__icon">{icon}</span> : null}
          <div style={{ minWidth: 0, flex: 1 }}>
            <h2 className="modal__title" id={titleId}>
              {title}
            </h2>
            {description ? <p className="modal__desc">{description}</p> : null}
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="Fermer"
            style={{ marginTop: -2 }}
          >
            <X size={15} />
          </button>
        </div>
        <div className="modal__body">{children}</div>
        {footer ? <div className="modal__foot">{footer}</div> : null}
      </div>
    </div>
  );
}

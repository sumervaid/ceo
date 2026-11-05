import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Check, ChevronDown, X } from "lucide-react";

import type { Provider } from "../../shared/api";
import { PROVIDER_LABEL } from "../format";

type Tone = "primary" | "default" | "ghost" | "danger" | "accent";
export function Button({ tone = "default", size = "md", icon, children, className = "", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone; size?: "sm" | "md" | "lg"; icon?: ReactNode }) {
  return (
    <button {...rest} className={`btn btn-${tone} btn-${size} ${children ? "" : "btn-icon"} ${className}`}>
      {icon}
      {children}
    </button>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function ProviderMark({ provider, size = 8 }: { provider: Provider | string; size?: number }) {
  return <span className={`pmark pmark-${provider}`} style={{ width: size, height: size }} title={PROVIDER_LABEL[provider as Provider] ?? provider} />;
}

export function Spinner({ size = 12 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} />;
}

export function Dialog({ title, subtitle, children, footer, onClose, width = 560, testId }: { title: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode; onClose: () => void; width?: number; testId?: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" style={{ width }} role="dialog" aria-modal="true" data-testid={testId}>
        <header className="dialog-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <Button tone="ghost" size="sm" icon={<X size={15} />} onClick={onClose} aria-label="Close" />
        </header>
        <div className="dialog-body">{children}</div>
        {footer && <footer className="dialog-foot">{footer}</footer>}
      </div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export type MenuItem = { label: ReactNode; detail?: ReactNode; icon?: ReactNode; onClick?: () => void; checked?: boolean; danger?: boolean; disabled?: boolean; separator?: boolean };

export function Menu({ trigger, items, align = "left", up = false }: { trigger: (open: boolean, toggle: () => void) => ReactNode; items: MenuItem[]; align?: "left" | "right"; up?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", key);
    };
  }, [open]);
  return (
    <div className="menu-wrap" ref={ref}>
      {trigger(open, () => setOpen(!open))}
      {open && (
        <div className={`menu menu-${align} ${up ? "menu-up" : ""}`} role="menu">
          {items.map((it, i) =>
            it.separator ? (
              <div className="menu-sep" key={i} />
            ) : (
              <button
                key={i}
                role="menuitem"
                disabled={it.disabled}
                className={`menu-item ${it.danger ? "menu-danger" : ""}`}
                onClick={() => {
                  setOpen(false);
                  it.onClick?.();
                }}
              >
                {it.icon && <span className="menu-icon">{it.icon}</span>}
                <span className="menu-text">
                  <span>{it.label}</span>
                  {it.detail && <small>{it.detail}</small>}
                </span>
                {it.checked && <Check size={14} className="menu-check" />}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

export function Select<T extends string>({ value, options, onChange, label, up, align }: { value: T; options: Array<{ value: T; label: ReactNode; detail?: ReactNode; icon?: ReactNode; disabled?: boolean }>; onChange: (v: T) => void; label?: ReactNode; up?: boolean; align?: "left" | "right" }) {
  const cur = options.find((o) => o.value === value);
  return (
    <Menu
      up={up}
      align={align}
      trigger={(_o, toggle) => (
        <button type="button" className="select" onClick={toggle}>
          {cur?.icon}
          <span>{label ?? cur?.label ?? value}</span>
          <ChevronDown size={13} className="select-chev" />
        </button>
      )}
      items={options.map((o) => ({ label: o.label, detail: o.detail, icon: o.icon, checked: o.value === value, disabled: o.disabled, onClick: () => onChange(o.value) }))}
    />
  );
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon">{icon}</div>}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Stat({ label, value, detail }: { label: string; value: ReactNode; detail?: ReactNode }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {detail && <span className="stat-detail">{detail}</span>}
    </div>
  );
}

export function Resizer({ onDrag, side }: { onDrag: (x: number) => void; side: "left" | "right" }) {
  return (
    <div
      className={`resizer resizer-${side}`}
      onPointerDown={(e) => {
        e.preventDefault();
        const move = (ev: PointerEvent): void => onDrag(ev.clientX);
        const up = (): void => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          document.body.classList.remove("resizing");
        };
        document.body.classList.add("resizing");
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      }}
    />
  );
}

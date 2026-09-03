import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "./icons.js";
import { motion, AnimatePresence } from "./motion.js";

// Right-anchored panel over a dimmed room. Same interaction contract as Modal (backdrop click,
// Esc, body-scroll lock) — used for on-demand context that sits beside the case, not over it.
export function Drawer({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="drawer-scrim"
          data-surface="room"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onClick={onClose}
        >
          <motion.aside
            className="drawer"
            role="dialog"
            aria-modal="true"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="drawer__head">
              <span className="drawer__title">{title}</span>
              <button className="btn btn--ghost drawer__close" onClick={onClose} aria-label="Close">
                <X size={14} />
              </button>
            </div>
            <div className="drawer__body">{children}</div>
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

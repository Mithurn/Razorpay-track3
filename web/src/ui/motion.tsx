import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

export { motion, AnimatePresence } from "motion/react";

const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export const blockIn = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
  transition: { duration: 0.18, ease: [0.16, 1, 0.3, 1] as const },
};

export function Spinner({ size = 14, className }: { size?: number; className?: string }) {
  return <Loader2 size={size} className={"spin " + (className ?? "")} />;
}

// Types the model's live narration in as it streams — new characters appear a few at a time
// rather than the whole line snapping in. Never persisted; only ever fed the live text.
export function StreamingText({ text, className }: { text: string; className?: string }) {
  const [shown, setShown] = useState(text);
  const target = useRef(text);
  target.current = text;

  useEffect(() => {
    if (prefersReducedMotion()) {
      setShown(text);
      return;
    }
    let raf = 0;
    const tick = () => {
      setShown((cur) => {
        const want = target.current;
        if (cur === want) return cur;
        if (!want.startsWith(cur)) return want.slice(0, cur.length > want.length ? want.length : cur.length + 3);
        return want.slice(0, cur.length + 3);
      });
      raf = window.setTimeout(tick, 16);
    };
    raf = window.setTimeout(tick, 16);
    return () => window.clearTimeout(raf);
  }, [text]);

  return (
    <span className={className}>
      {shown}
      {shown !== text && <span className="caret" />}
    </span>
  );
}

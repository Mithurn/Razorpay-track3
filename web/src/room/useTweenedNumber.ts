import { useEffect, useRef, useState } from "react";

// Hand-rolled rather than a library: ~20 lines, full control over "animate only the delta that
// just arrived over SSE," easeOutCubic, respects prefers-reduced-motion by snapping instead.
const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function useTweenedNumber(target: number, ms = 600): number {
  const [display, setDisplay] = useState(target);
  const fromRef = useRef(target);
  const firstRef = useRef(true);

  useEffect(() => {
    if (firstRef.current) {
      firstRef.current = false;
      fromRef.current = target;
      setDisplay(target);
      return;
    }
    if (reduceMotion()) {
      fromRef.current = target;
      setDisplay(target);
      return;
    }
    const from = fromRef.current;
    const start = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / ms);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(Math.round(from + (target - from) * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, ms]);

  return display;
}

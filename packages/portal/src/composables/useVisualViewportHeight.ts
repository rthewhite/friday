import { onBeforeUnmount, onMounted } from "vue";
import { DESKTOP } from "./useMediaQuery.js";

/** The CSS variable holding the visible height, for a page that fills the screen (the Chat page). */
export const VIEWPORT_VAR = "--f-viewport-h";

/**
 * Keep `--f-viewport-h` on <html> at the height of the visible part of the page while the calling component is
 * mounted. iOS doesn't shrink `dvh` for the on-screen keyboard: it pans the page up instead, so the top bar slides
 * out of view. Following the visual viewport shrinks the page with the keyboard, and scrolling back to the top undoes
 * the pan. Nothing happens while the user has pinch-zoomed (that would fight the zoom), on the desktop layout, or in
 * a browser without `visualViewport`, where the page keeps its `100dvh` fallback.
 */
export function useVisualViewportHeight(): void {
  const vv = typeof window !== "undefined" ? window.visualViewport : null;
  if (!vv) return;
  const root = document.documentElement;
  const desktop = () => typeof window.matchMedia === "function" && window.matchMedia(DESKTOP).matches;

  const update = () => {
    if (Math.abs(vv.scale - 1) > 0.01) return;
    root.style.setProperty(VIEWPORT_VAR, `${vv.height}px`);
    if (!desktop() && (window.scrollY !== 0 || vv.offsetTop !== 0)) window.scrollTo(0, 0);
  };

  onMounted(() => {
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
  });
  onBeforeUnmount(() => {
    vv.removeEventListener("resize", update);
    vv.removeEventListener("scroll", update);
    root.style.removeProperty(VIEWPORT_VAR);
  });
}

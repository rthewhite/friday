import { onBeforeUnmount, onMounted } from "vue";
import { DESKTOP } from "./useMediaQuery.js";

/** The CSS variable holding the visible height, for a page that fills the screen (the Chat page). */
export const VIEWPORT_VAR = "--f-viewport-h";

/**
 * Keep `--f-viewport-h` on <html> at the height of the visible part of the page while the calling component is
 * mounted. iOS doesn't shrink `dvh` for the on-screen keyboard: it pans the page up instead, so the top bar slides
 * out of view. Following the visual viewport shrinks the page with the keyboard, and scrolling back to the top when
 * the keyboard opens or closes (a resize) undoes the pan. Viewport scroll events only update the height: answering
 * each of them with a scroll could fight iOS keeping the caret in view. Updates are coalesced to one per frame.
 * Nothing happens while the user has pinch-zoomed (that would fight the zoom), and there is no scrolling on the
 * desktop layout. Without `visualViewport` the page keeps its `100dvh` fallback.
 */
export function useVisualViewportHeight(): void {
  const vv = typeof window !== "undefined" ? window.visualViewport : null;
  if (!vv) return;
  const root = document.documentElement;
  const desktop = typeof window.matchMedia === "function" ? window.matchMedia(DESKTOP) : undefined;
  let frame = 0;
  let resized = false;
  let written = "";

  const apply = () => {
    frame = 0;
    const undoPan = resized;
    resized = false;
    if (Math.abs(vv.scale - 1) > 0.01) return;
    const height = `${vv.height}px`;
    if (height !== written) {
      root.style.setProperty(VIEWPORT_VAR, height);
      written = height;
    }
    if (undoPan && !desktop?.matches && (window.scrollY !== 0 || vv.offsetTop !== 0)) window.scrollTo(0, 0);
  };
  const schedule = (e?: Event) => {
    if (e?.type === "resize") resized = true;
    if (!frame) frame = requestAnimationFrame(apply);
  };

  onMounted(() => {
    resized = true;
    apply();
    vv.addEventListener("resize", schedule);
    vv.addEventListener("scroll", schedule);
  });
  onBeforeUnmount(() => {
    vv.removeEventListener("resize", schedule);
    vv.removeEventListener("scroll", schedule);
    if (frame) cancelAnimationFrame(frame);
    root.style.removeProperty(VIEWPORT_VAR);
  });
}

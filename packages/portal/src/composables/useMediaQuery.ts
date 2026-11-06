import { onBeforeUnmount, readonly, ref, type Ref } from "vue";

/** From this width the portal shows its desktop layout (Tailwind's `md`). */
export const DESKTOP = "(min-width: 768px)";

/**
 * Whether `query` matches, kept up to date while the calling component is mounted. False where the browser has no
 * `matchMedia`.
 */
export function useMediaQuery(query: string): Readonly<Ref<boolean>> {
  const list = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query) : undefined;
  const matches = ref(list?.matches ?? false);
  if (list) {
    const onChange = (e: MediaQueryListEvent) => (matches.value = e.matches);
    list.addEventListener("change", onChange);
    onBeforeUnmount(() => list.removeEventListener("change", onChange));
  }
  return readonly(matches);
}

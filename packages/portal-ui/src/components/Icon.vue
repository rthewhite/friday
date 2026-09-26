<script setup lang="ts">
/** Small inline SVG set. Unknown names render as text so module UIs may still pass emoji. */
const paths: Record<string, string> = {
  mic: "M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-2.08A7 7 0 0 0 19 12h-2Z",
  grid: "M4 4h7v7H4V4Zm9 0h7v7h-7V4ZM4 13h7v7H4v-7Zm9 0h7v7h-7v-7Z",
  play: "M8 5v14l11-7L8 5Z",
  settings: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm8.94 3a8.9 8.9 0 0 0-.66-2.2l1.72-1.34-2-3.46-2.05.83A9 9 0 0 0 16 3.6L15.7 1.4h-4l-.3 2.2a9 9 0 0 0-1.95 1.23L7.4 4 5.4 7.46l1.72 1.34A8.9 8.9 0 0 0 6.46 11H4v2h2.46a8.9 8.9 0 0 0 .66 2.2L5.4 16.54l2 3.46 2.05-.83A9 9 0 0 0 11.4 20.4l.3 2.2h4l.3-2.2a9 9 0 0 0 1.95-1.23l2.05.83 2-3.46-1.72-1.34a8.9 8.9 0 0 0 .66-2.2H22v-2h-2.06Z",
  key: "M14 2a6 6 0 0 0-5.65 8L2 16.35V22h5.65l1.42-1.42V18.4h2.18l1.42-1.41V14.8h1.42A6 6 0 1 0 14 2Zm2 6a2 2 0 1 1 0-4 2 2 0 0 1 0 4Z",
  refresh: "M12 5V2L7 7l5 5V8a4 4 0 1 1-4 4H6a6 6 0 1 0 6-7Z",
  plus: "M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5Z",
  close: "M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6L19 6.4 17.6 5 12 10.6 6.4 5Z",
  chevron: "M9 6l6 6-6 6-1.4-1.4L12.2 12 7.6 7.4 9 6Z",
  server: "M4 4h16v6H4V4Zm0 10h16v6H4v-6Zm3-8v2h2V6H7Zm0 10v2h2v-2H7Z",
  link: "M10 17H7a5 5 0 0 1 0-10h3v2H7a3 3 0 0 0 0 6h3v2Zm4-10h3a5 5 0 0 1 0 10h-3v-2h3a3 3 0 0 0 0-6h-3V7Zm-6 4h8v2H8v-2Z",
};
withDefaults(defineProps<{ name?: string; size?: number }>(), { size: 16 });
</script>

<template>
  <svg v-if="name && paths[name]" :width="size" :height="size" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path :d="paths[name]" />
  </svg>
  <span v-else class="inline-block text-center" :style="{ width: `${size}px` }" aria-hidden="true">{{ name ?? "•" }}</span>
</template>

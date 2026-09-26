<script setup lang="ts" generic="T extends Record<string, unknown>">
export interface Column {
  key: string;
  label: string;
  width?: string;
  align?: "left" | "center" | "right";
  /** Hide this column below the given Tailwind breakpoint. */
  hideBelow?: "md" | "lg";
}
defineProps<{ columns: Column[]; rows: T[]; rowKey: string; empty?: string; clickable?: boolean }>();
const emit = defineEmits<{ "row-click": [row: T] }>();
const hide = { md: "hidden md:table-cell", lg: "hidden lg:table-cell" };
</script>

<template>
  <div class="surface-card overflow-x-auto">
    <table class="w-full text-sm">
      <thead>
        <tr class="bg-f-surface-elevated text-left text-xs uppercase tracking-wide text-f-text-muted">
          <th v-for="c in columns" :key="c.key" :class="['px-4 py-3 font-medium', c.align === 'right' && 'text-right', c.align === 'center' && 'text-center', c.hideBelow && hide[c.hideBelow]]" :style="c.width ? { width: c.width } : undefined">{{ c.label }}</th>
          <th v-if="$slots.actions" class="px-4 py-3"></th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 1" class="px-4 py-8 text-center text-f-text-muted">{{ empty ?? "Nothing here" }}</td>
        </tr>
        <tr
          v-for="row in rows"
          :key="String(row[rowKey])"
          :class="['border-t border-f-border-subtle transition', clickable && 'cursor-pointer hover:bg-f-surface-hover/50']"
          @click="clickable && emit('row-click', row)"
        >
          <td v-for="c in columns" :key="c.key" :class="['px-4 py-3 align-top', c.align === 'right' && 'text-right', c.align === 'center' && 'text-center', c.hideBelow && hide[c.hideBelow]]">
            <slot :name="`cell-${c.key}`" :row="row" :value="row[c.key]">{{ row[c.key] ?? "" }}</slot>
          </td>
          <td v-if="$slots.actions" class="px-4 py-3 text-right whitespace-nowrap" @click.stop><slot name="actions" :row="row" /></td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup lang="ts" generic="T extends Record<string, unknown>">
defineProps<{ columns: { key: string; label: string }[]; rows: T[]; rowKey: string; empty?: string }>();
</script>

<template>
  <div class="overflow-x-auto surface-inset">
    <table class="w-full text-sm">
      <thead>
        <tr class="text-left text-f-text-muted border-b border-f-border-subtle">
          <th v-for="c in columns" :key="c.key" class="px-3 py-2 font-medium">{{ c.label }}</th>
          <th v-if="$slots.actions" class="px-3 py-2"></th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 1" class="px-3 py-6 text-center text-f-text-muted">{{ empty ?? "Nothing here" }}</td>
        </tr>
        <tr v-for="row in rows" :key="String(row[rowKey])" class="border-b border-f-border-subtle last:border-0 hover:bg-f-surface-hover/40">
          <td v-for="c in columns" :key="c.key" class="px-3 py-2 align-top">
            <slot :name="`cell-${c.key}`" :row="row" :value="row[c.key]">{{ row[c.key] ?? "" }}</slot>
          </td>
          <td v-if="$slots.actions" class="px-3 py-2 text-right whitespace-nowrap"><slot name="actions" :row="row" /></td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup lang="ts">
defineProps<{ endSessionUrl: string | null }>();
</script>

<template>
  <main class="min-h-screen grid place-items-center p-8">
    <div class="max-w-md flex flex-col gap-3">
      <h1 class="text-lg font-semibold text-f-text-bright">You are logged out of Friday</h1>
      <p class="text-f-text-muted">
        Your Authentik login is still active, so logging in again won't ask for your password.
        <template v-if="endSessionUrl">To switch accounts, log out of Authentik too.</template>
      </p>
      <div class="flex gap-4">
        <a class="text-f-accent-bright hover:underline" href="/auth/login">Log in again</a>
        <a v-if="endSessionUrl" class="text-f-accent-bright hover:underline" :href="endSessionUrl">Log out of Authentik</a>
      </div>
    </div>
  </main>
</template>

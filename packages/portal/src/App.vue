<script setup lang="ts">
import Shell from "./shell/Shell.vue";
import LoggedOut from "./shell/LoggedOut.vue";
import { loggedOut } from "./composables/useSession.js";
</script>

<template>
  <LoggedOut v-if="loggedOut" :end-session-url="loggedOut.endSessionUrl" />
  <Shell v-else />
</template>

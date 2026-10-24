<script setup lang="ts">
import { iconColourOn, walletIconClass } from './walletForm'

withDefaults(defineProps<{ icon: string; colour: string; large?: boolean }>(), { large: false })
</script>

<template>
  <!-- Decorative: the wallet's name always sits next to it. -->
  <span
    class="inline-flex shrink-0 items-center justify-center rounded-full"
    :class="large ? 'size-12 text-xl' : 'size-10 text-base'"
    :style="{ backgroundColor: colour, color: iconColourOn(colour) }"
    aria-hidden="true"
  >
    <span :class="walletIconClass(icon)" />
  </span>
</template>

<script setup lang="ts">
import { iconColourOn, accountIconClass } from './accountForm'

withDefaults(defineProps<{ icon: string; colour: string; large?: boolean; small?: boolean }>(), {
  large: false,
  small: false,
})
</script>

<template>
  <!-- Decorative: the account's or group's name always sits next to it. -->
  <span
    class="inline-flex shrink-0 items-center justify-center rounded-full"
    :class="large ? 'size-12 text-xl' : small ? 'size-8 text-sm' : 'size-10 text-base'"
    :style="{ backgroundColor: colour, color: iconColourOn(colour) }"
    aria-hidden="true"
  >
    <span :class="accountIconClass(icon)" />
  </span>
</template>

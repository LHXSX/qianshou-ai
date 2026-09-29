<template><a class="qs-brand" :href="href" aria-label="千手官网首页"><img src="/favicon.svg" alt="" aria-hidden="true" width="36" height="36"/><span>千手<span class="qs-brand-en">QIANSHOU</span></span></a></template>
<script lang="ts">
import { defineComponent } from 'vue'
export default defineComponent({ props: { href: { type: String, default: '/#/' } } })
</script>
<style scoped>.qs-brand{display:inline-flex;align-items:center;gap:11px;color:var(--qs-text);text-decoration:none;font-size:21px;letter-spacing:2px;font-weight:700;white-space:nowrap}.qs-brand img{display:block;width:36px;height:36px;flex:none}.qs-brand-en{display:block;font:9px/1.2 monospace;letter-spacing:3px;color:var(--qs-muted);margin-top:4px}</style>

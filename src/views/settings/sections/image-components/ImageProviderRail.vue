<script setup>
defineProps({
  providers: { type: Array, default: () => [] },
  selectedId: { type: String, default: null },
  isDark: { type: Boolean, default: false },
  accentHex: { type: String, default: '#4A6CFF' },
})
defineEmits(['select', 'add'])
</script>

<template>
  <div class="w-[240px] shrink-0 border-r-2 rounded-md border-solid overflow-y-auto flex flex-col"
    :class="isDark ? 'border-bdrL bg-d0' : 'border-bdrL bg-l0'">
    <div class="px-3 py-3 shrink-0"
      :class="isDark ? 'bg-d3/60 border-b border-d4' : 'bg-l3/60 border-b border-bdrL'">
      <div class="flex items-center gap-2">
        <i class="ri-image-circle-ai-line text-[14px] text-sky-400" />
        <span class="text-[12.5px] font-medium" :class="isDark ? 'text-wt-main' : 'text-lt-main'">图像服务商</span>
        <span class="ml-auto text-[11px] px-1.5 py-0.5 rounded"
          :class="isDark ? 'bg-d0 text-wt-dim' : 'bg-l2 text-lt-aux'">{{ providers.length }}</span>
      </div>
    </div>
    <div class="flex-1 px-1.5 py-1.5 space-y-0.5">
      <button
        v-for="p in providers" :key="p.id"
        class="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md relative transition-colors"
        :class="selectedId === p.id
          ? (isDark ? 'bg-white/6' : 'bg-l3')
          : (isDark ? 'hover:bg-white/4' : 'hover:bg-l4')"
        @click="$emit('select', p.id)">
        <span v-show="selectedId === p.id"
          class="absolute left-0 top-2.5 bottom-2.5 w-[3px] rounded-r"
          :style="{ backgroundColor: accentHex }" />
        <div class="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 overflow-hidden"
          :class="isDark ? 'bg-d3' : 'bg-l3'">
          <SvgIcon :icon-class="p.iconName || 'wand-magic-sparkles'" :size="20" />
        </div>
        <div class="flex-1 min-w-0 text-left">
          <span class="truncate block transition-all"
            :class="selectedId === p.id
              ? (isDark ? 'text-wt-main font-bold text-[13.5px]' : 'text-lt-main font-bold text-[13.5px]')
              : (isDark ? 'text-wt-sub font-medium text-[13px]' : 'text-lt-sub font-medium text-[13px]')">{{ p.name }}</span>
          <div class="flex items-center gap-1 mt-0.5">
            <span class="text-[11px]" :class="isDark ? 'text-wt-dim' : 'text-lt-aux'">{{ p.models.length }} 模型</span>
            <span class="text-[11px]" :class="isDark ? 'text-wt-dim/60' : 'text-lt-aux/60'">·</span>
            <span class="text-[11px]" :class="isDark ? 'text-wt-dim/60' : 'text-lt-aux/60'">{{ p.builtin ? '内置' : '自定义' }}</span>
            <i v-if="p.configured" class="ri-checkbox-circle-fill text-[11px] text-emerald-400 ml-auto" />
            <i v-else class="ri-error-warning-line text-[11px] text-amber-400 ml-auto" />
          </div>
        </div>
      </button>
    </div>
    <div class="px-1.5 pt-1 pb-2 shrink-0">
      <button
        class="w-full flex items-center justify-center gap-1.5 px-2.5 py-2 rounded-md text-[12px] font-medium text-white transition-opacity hover:opacity-90"
        :style="{ background: accentHex }"
        @click="$emit('add')">
        <i class="ri-add-line text-[14px]" /> 添加服务商
      </button>
    </div>
  </div>
</template>
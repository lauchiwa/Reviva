<script setup>
import { computed } from 'vue'
import { useImageModelsStore } from '@/stores/imageModels'
import OptionSelector from '@/components/OptionSelector.vue'

const props = defineProps({
  isDark: { type: Boolean, default: false },
  accentHex: { type: String, default: '#4A6CFF' },
})

const store = useImageModelsStore()

const generationOptions = computed(() =>
  store.generationModels.map(m => ({
    value: m.ref,
    label: m.modelName,
    description: m.providerName,
  }))
)
const editOptions = computed(() =>
  store.editModels.map(m => ({
    value: m.ref,
    label: m.modelName,
    description: m.providerName,
  }))
)
const defaultGen = computed({
  get: () => store.defaultModels.generation,
  set: v => { if (v) store.setDefaultModel('generation', v) },
})
const defaultEdit = computed({
  get: () => store.defaultModels.edit,
  set: v => { if (v) store.setDefaultModel('edit', v) },
})
</script>

<template>
  <div class="flex items-center gap-3 px-4 py-2.5 rounded-lg border shrink-0"
    :class="isDark ? 'bg-d2 border-d4' : 'bg-l2 border-bdrL'">
    <div class="flex items-center gap-1.5 shrink-0">
      <i class="ri-star-line text-[15px] text-amber-400" />
      <span class="text-[12.5px] font-semibold" :class="isDark ? 'text-wt-main' : 'text-lt-main'">默认模型</span>
    </div>
    <div class="w-px h-5 shrink-0" :class="isDark ? 'bg-d4' : 'bg-bdrL'" />
    <div class="flex items-center gap-2 shrink-0">
      <span class="text-[10px] shrink-0 px-1.5 py-0.5 rounded font-medium text-sky-400 bg-sky-400/8">生图</span>
      <OptionSelector
        :model-value="defaultGen"
        @update:model-value="v => defaultGen = v"
        :options="generationOptions"
        :is-dark="isDark"
        default-accent="sky"
        size="compact"
        trigger-class="h-8"
        :style="{ width: '260px' }"
        placeholder="未设置"
      />
    </div>
    <div class="flex items-center gap-2 shrink-0">
      <span class="text-[10px] shrink-0 px-1.5 py-0.5 rounded font-medium text-violet-400 bg-violet-400/8">编辑</span>
      <OptionSelector
        :model-value="defaultEdit"
        @update:model-value="v => defaultEdit = v"
        :options="editOptions"
        :is-dark="isDark"
        default-accent="amber"
        size="compact"
        trigger-class="h-8"
        :style="{ width: '260px' }"
        placeholder="未设置"
      />
    </div>
    <span class="ml-auto text-[10.5px] shrink-0 hidden lg:block" :class="isDark ? 'text-wt-dim' : 'text-lt-aux'">
      仅显示已启用且具备对应能力的模型
    </span>
  </div>
</template>
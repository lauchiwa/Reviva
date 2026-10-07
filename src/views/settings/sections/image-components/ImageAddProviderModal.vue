<script setup>
import { reactive, watch, computed } from 'vue'
import MsModal from '@/components/MsModal/MsModal.vue'
import OptionSelector from '@/components/OptionSelector.vue'
import { IMAGE_API_FORMATS } from '@/stores/imageModels'

const props = defineProps({
  show: { type: Boolean, default: false },
  isDark: { type: Boolean, default: false },
  accentHex: { type: String, default: '#4A6CFF' },
})
const emit = defineEmits(['update:show', 'confirm'])

const form = reactive({ name: '', baseUrl: '', apiFormat: 'openai_images' })
const formatOptions = IMAGE_API_FORMATS.map(f => ({ value: f.value, label: f.label, description: f.desc }))

watch(() => props.show, v => {
  if (v) Object.assign(form, { name: '', baseUrl: '', apiFormat: 'openai_images' })
})

function onConfirm() {
  if (!form.name.trim()) return
  emit('confirm', { ...form })
  emit('update:show', false)
}

const inputCls = computed(() =>
  props.isDark
    ? 'bg-d2 border-d4 text-wt-main placeholder-wt-dim focus:border-sky-400/40'
    : 'bg-l2 border-bdrL text-lt-main placeholder-lt-aux focus:border-sky-400'
)
</script>

<template>
  <MsModal :show="show" @update:show="v => emit('update:show', v)" :width="480" :show-footer="false">
    <template #header>
      <span class="text-[15px] font-semibold" :class="isDark ? 'text-wt-main' : 'text-lt-main'">添加自定义图像服务商</span>
    </template>
    <div class="space-y-4">
      <div>
        <label class="block text-[11px] mb-1.5 font-medium" :class="isDark ? 'text-wt-sub' : 'text-lt-sub'">名称</label>
        <input v-model="form.name"
          class="w-full h-9 rounded-lg px-3 text-[13px] border outline-none transition-colors"
          :class="inputCls" placeholder="如：我的图床" />
      </div>
      <div>
        <label class="block text-[11px] mb-1.5 font-medium" :class="isDark ? 'text-wt-sub' : 'text-lt-sub'">Base URL</label>
        <input v-model="form.baseUrl"
          class="w-full h-9 rounded-lg px-3 text-[13px] border outline-none transition-colors"
          :class="inputCls" placeholder="https://api.example.com/v1" />
      </div>
      <div>
        <label class="block text-[11px] mb-1.5 font-medium" :class="isDark ? 'text-wt-sub' : 'text-lt-sub'">API 格式</label>
        <OptionSelector
          :model-value="form.apiFormat"
          @update:model-value="v => form.apiFormat = v"
          :options="formatOptions"
          :is-dark="isDark"
          default-accent="sky"
          size="compact"
          trigger-class="w-full h-9" />
        <p class="text-[10.5px] mt-1.5" :class="isDark ? 'text-wt-dim' : 'text-lt-aux'">
          {{ IMAGE_API_FORMATS.find(f => f.value === form.apiFormat)?.desc }}
        </p>
      </div>
    </div>
    <div class="flex justify-end gap-2 mt-6">
      <button
        class="h-9 px-4 rounded-lg text-[12px] font-medium border transition-colors"
        :class="isDark ? 'border-d4 text-wt-sub hover:bg-d2' : 'border-bdrL text-lt-sub hover:bg-l2'"
        @click="emit('update:show', false)">取消</button>
      <button
        class="h-9 px-4 rounded-lg text-[12px] font-medium text-white transition-opacity"
        :style="{ background: accentHex }"
        :disabled="!form.name.trim()"
        :class="{ 'opacity-50 cursor-not-allowed': !form.name.trim() }"
        @click="onConfirm">添加</button>
    </div>
  </MsModal>
</template>
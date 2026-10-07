<script setup>
import { reactive, watch, computed } from 'vue'
import MsModal from '@/components/MsModal/MsModal.vue'
import OptionSelector from '@/components/OptionSelector.vue'

const props = defineProps({
  show: { type: Boolean, default: false },
  isDark: { type: Boolean, default: false },
  accentHex: { type: String, default: '#4A6CFF' },
  providerName: { type: String, default: '' },
})
const emit = defineEmits(['update:show', 'confirm'])

const form = reactive({
  id: '',
  name: '',
  generation: true,
  edit: false,
  sizeMode: 'presets',
  maxImages: 1,
  sizes: [],
})

const sizeModeOptions = [
  { value: 'presets', label: '预设列表' },
  { value: 'free', label: '自由（任意）' },
]

const QUICK_SIZES = [
  { ratio: '1:1', value: '1024x1024' },
  { ratio: '16:9', value: '1792x1024' },
  { ratio: '9:16', value: '1024x1792' },
  { ratio: '3:2', value: '1536x1024' },
  { ratio: '2:3', value: '1024x1536' },
]

watch(() => props.show, v => {
  if (v) Object.assign(form, {
    id: '', name: '', generation: true, edit: false,
    sizeMode: 'presets', maxImages: 1, sizes: [],
  })
})

function addSize() {
  form.sizes.push({ ratio: '', value: '' })
}
function removeSize(i) {
  form.sizes.splice(i, 1)
}
function addQuickSize(q) {
  if (form.sizes.some(s => s.ratio === q.ratio)) return
  form.sizes.push({ ratio: q.ratio, value: q.value })
}

function onConfirm() {
  if (!form.id.trim() || !form.name.trim()) return
  if (!form.generation && !form.edit) return
  const sizes = form.sizes.filter(s => s.ratio.trim() || s.value.trim())
  emit('confirm', {
    id: form.id.trim(),
    name: form.name.trim(),
    generation: form.generation,
    edit: form.edit,
    sizeMode: form.sizeMode,
    sizes,
    maxImages: Math.max(1, Math.min(20, Number(form.maxImages) || 1)),
  })
  emit('update:show', false)
}

const inputCls = computed(() =>
  props.isDark
    ? 'bg-d2 border-d4 text-wt-main placeholder-wt-dim focus:border-sky-400/40'
    : 'bg-l2 border-bdrL text-lt-main placeholder-lt-aux focus:border-sky-400'
)
const canSubmit = computed(() => form.id.trim() && form.name.trim() && (form.generation || form.edit))
</script>

<template>
  <MsModal :show="show" @update:show="v => emit('update:show', v)" :width="520" :show-footer="false">
    <template #header>
      <span class="text-[15px] font-semibold" :class="isDark ? 'text-wt-main' : 'text-lt-main'">
        添加图像模型
        <span v-if="providerName" class="text-[12px] font-normal" :class="isDark ? 'text-wt-dim' : 'text-lt-aux'"> · {{ providerName }}</span>
      </span>
    </template>

    <!-- basic info -->
    <div class="space-y-3.5">
      <div>
        <label class="block text-[11px] mb-1.5 font-medium" :class="isDark ? 'text-wt-sub' : 'text-lt-sub'">模型 ID</label>
        <input v-model="form.id"
          class="w-full h-9 rounded-lg px-3 text-[13px] border outline-none transition-colors"
          :class="inputCls" placeholder="如：gpt-image-1" />
      </div>
      <div>
        <label class="block text-[11px] mb-1.5 font-medium" :class="isDark ? 'text-wt-sub' : 'text-lt-sub'">显示名称</label>
        <input v-model="form.name"
          class="w-full h-9 rounded-lg px-3 text-[13px] border outline-none transition-colors"
          :class="inputCls" placeholder="如：GPT Image 1" />
      </div>
      <div>
        <label class="block text-[11px] mb-2 font-medium" :class="isDark ? 'text-wt-sub' : 'text-lt-sub'">模型能力</label>
        <div class="flex gap-2">
          <button
            class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[12.5px] font-medium transition-all"
            :class="form.generation
              ? 'text-sky-400 bg-sky-400/8 border-sky-400/40'
              : (isDark ? 'text-wt-dim bg-d2 border-d4 hover:bg-d4' : 'text-lt-aux bg-l2 border-bdrL hover:bg-l4')"
            @click="form.generation = !form.generation">
            <i :class="form.generation ? 'ri-checkbox-circle-fill' : 'ri-checkbox-blank-circle-line'" class="text-[14px]" />
            生图
          </button>
          <button
            class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[12.5px] font-medium transition-all"
            :class="form.edit
              ? 'text-violet-400 bg-violet-400/8 border-violet-400/40'
              : (isDark ? 'text-wt-dim bg-d2 border-d4 hover:bg-d4' : 'text-lt-aux bg-l2 border-bdrL hover:bg-l4')"
            @click="form.edit = !form.edit">
            <i :class="form.edit ? 'ri-checkbox-circle-fill' : 'ri-checkbox-blank-circle-line'" class="text-[14px]" />
            编辑
          </button>
        </div>
        <p class="text-[10.5px] mt-1.5" :class="isDark ? 'text-wt-dim' : 'text-lt-aux'">勾选模型支持的能力，至少选择一项</p>
      </div>
    </div>

    <!-- divider -->
    <div class="flex items-center gap-2 my-4">
      <div class="flex-1 h-px" :class="isDark ? 'bg-d4' : 'bg-bdrL'" />
      <i class="ri-aspect-ratio-line text-[13px] text-sky-400" />
      <span class="text-[11.5px] font-medium" :class="isDark ? 'text-wt-sub' : 'text-lt-sub'">尺寸与比例</span>
      <div class="flex-1 h-px" :class="isDark ? 'bg-d4' : 'bg-bdrL'" />
    </div>

    <!-- size config -->
    <div class="space-y-3">
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="block text-[11px] mb-1.5 font-medium" :class="isDark ? 'text-wt-sub' : 'text-lt-sub'">尺寸模式</label>
          <OptionSelector
            :model-value="form.sizeMode"
            @update:model-value="v => form.sizeMode = v"
            :options="sizeModeOptions" :is-dark="isDark"
            default-accent="sky" size="compact" trigger-class="w-full h-9" />
        </div>
        <div>
          <label class="block text-[11px] mb-1.5 font-medium" :class="isDark ? 'text-wt-sub' : 'text-lt-sub'">单次最大张数</label>
          <input v-model="form.maxImages" type="number" min="1" max="20"
            class="w-full h-9 rounded-lg px-3 text-[13px] border outline-none transition-colors"
            :class="inputCls" />
        </div>
      </div>

      <!-- quick add ratios -->
      <div>
        <label class="block text-[11px] mb-1.5 font-medium" :class="isDark ? 'text-wt-sub' : 'text-lt-sub'">快捷比例</label>
        <div class="flex gap-1.5 flex-wrap">
          <button v-for="q in QUICK_SIZES" :key="q.ratio"
            class="px-2.5 py-1 rounded-lg border text-[11.5px] font-medium transition-colors"
            :class="form.sizes.some(s => s.ratio === q.ratio)
              ? 'text-sky-400 bg-sky-400/8 border-sky-400/40 cursor-default'
              : (isDark
                ? 'text-wt-sub bg-d2 border-d4 hover:bg-d4 hover:text-wt-main'
                : 'text-lt-sub bg-l2 border-bdrL hover:bg-l4 hover:text-lt-main')"
            :disabled="form.sizes.some(s => s.ratio === q.ratio)"
            @click="addQuickSize(q)">
            {{ q.ratio }}
          </button>
        </div>
      </div>

      <!-- size list -->
      <div>
        <div class="flex items-center gap-1.5 mb-1.5">
          <span class="text-[11px] font-medium" :class="isDark ? 'text-wt-sub' : 'text-lt-sub'">支持的尺寸</span>
          <button class="text-[11px] px-1.5 py-0.5 rounded border transition-colors"
            :class="isDark ? 'border-d4 hover:bg-d3' : 'border-bdrL hover:bg-l3'" :style="{ color: accentHex }"
            @click="addSize"><i class="ri-add-line" /> 添加</button>
        </div>
        <div v-for="(s, i) in form.sizes" :key="i" class="flex items-center gap-2 mb-1.5">
          <input v-model="s.ratio"
            class="w-[100px] h-8 rounded-lg px-2 text-[12px] border outline-none transition-colors"
            :class="inputCls" placeholder="比例 16:9" />
          <input v-model="s.value"
            class="flex-1 h-8 rounded-lg px-2 text-[12px] border outline-none transition-colors"
            :class="inputCls" placeholder="如 1792x1024 / 1280*720" />
          <button class="w-8 h-8 rounded-lg grid place-items-center text-red-400 hover:bg-red-400/8 shrink-0 transition-colors"
            @click="removeSize(i)"><i class="ri-delete-bin-line text-[13px]" /></button>
        </div>
        <p v-if="!form.sizes.length" class="text-[11px]" :class="isDark ? 'text-wt-dim' : 'text-lt-aux'">
          {{ form.sizeMode === 'free' ? '自由模式：调用层按范围图校验。' : '暂无尺寸预设，可点击快捷比例或手动添加。' }}
        </p>
      </div>
    </div>

    <!-- actions -->
    <div class="flex justify-end gap-2 mt-6">
      <button
        class="h-9 px-4 rounded-lg text-[12px] font-medium border transition-colors"
        :class="isDark ? 'border-d4 text-wt-sub hover:bg-d2' : 'border-bdrL text-lt-sub hover:bg-l2'"
        @click="emit('update:show', false)">取消</button>
      <button
        class="h-9 px-4 rounded-lg text-[12px] font-medium text-white transition-opacity"
        :style="{ background: accentHex }"
        :disabled="!canSubmit"
        :class="{ 'opacity-50 cursor-not-allowed': !canSubmit }"
        @click="onConfirm">添加</button>
    </div>
  </MsModal>
</template>
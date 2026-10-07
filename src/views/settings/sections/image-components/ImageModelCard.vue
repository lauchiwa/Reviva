<script setup>
import { computed } from 'vue'
import { useImageModelsStore } from '@/stores/imageModels'
import OptionSelector from '@/components/OptionSelector.vue'

const props = defineProps({
  providerId: { type: String, required: true },
  model: { type: Object, required: true },
  isDark: { type: Boolean, default: false },
  accentHex: { type: String, default: '' },
  expanded: { type: Boolean, default: false },
})
const emit = defineEmits(['toggle-expand', 'remove'])

const store = useImageModelsStore()
const m = computed(() => props.model)

const sizeModeOptions = [
  { value: 'presets', label: '预设列表' },
  { value: 'free', label: '自由（任意）' },
]
const defaultSizeOptions = computed(() => [
  { value: '', label: '未设置' },
  ...(m.value.sizes || []).map(s => ({ value: s.ratio, label: s.ratio })),
])

function toggleCap(cap) {
  const caps = { ...m.value.capabilities, [cap]: !m.value.capabilities[cap] }
  store.updateModelInProvider(props.providerId, m.value.id, { capabilities: caps })
}
function toggleEnabled() { store.updateModelInProvider(props.providerId, m.value.id, { enabled: !m.value.enabled }) }
function setMax(v) { store.updateModelInProvider(props.providerId, m.value.id, { maxImages: Math.max(1, Math.min(20, Number(v) || 1)) }) }
function setSizeMode(v) { store.updateModelInProvider(props.providerId, m.value.id, { sizeMode: v }) }
function setDefaultSize(v) { store.updateModelInProvider(props.providerId, m.value.id, { defaultSize: v }) }
function addSize() { store.updateModelInProvider(props.providerId, m.value.id, { sizes: [...(m.value.sizes || []), { ratio: '', value: '' }] }) }
function delSize(i) { const s = [...(m.value.sizes || [])]; s.splice(i, 1); store.updateModelInProvider(props.providerId, m.value.id, { sizes: s }) }
function setSizeRatio(i, v) { const s = [...(m.value.sizes || [])]; s[i] = { ...s[i], ratio: v }; store.updateModelInProvider(props.providerId, m.value.id, { sizes: s }) }
function setSizeValue(i, v) { const s = [...(m.value.sizes || [])]; s[i] = { ...s[i], value: v }; store.updateModelInProvider(props.providerId, m.value.id, { sizes: s }) }
function addParam() { if (!m.value.customParams) m.value.customParams = {}; m.value.customParams[''] = '' }
function delParam(k) { delete m.value.customParams[k] }
function renParam(oldK, e) { const v = m.value.customParams[oldK]; delete m.value.customParams[oldK]; m.value.customParams[e.target.value] = v }

const inputCls = computed(() =>
  props.isDark
    ? 'bg-d2 border-d4 text-wt-main placeholder-wt-dim focus:border-sky-400/40'
    : 'bg-l2 border-bdrL text-lt-main placeholder-lt-aux focus:border-sky-400'
)
</script>

<template>
  <div class="rounded-lg border" :class="isDark ? 'border-d4 bg-d2' : 'border-bdrL bg-l2'">
    <div class="flex items-center gap-2 px-2.5 py-2">
      <button class="w-5 h-5 grid place-items-center shrink-0 transition-colors"
        :class="isDark ? 'text-wt-dim hover:text-wt-main' : 'text-lt-aux hover:text-lt-main'"
        @click="emit('toggle-expand')">
        <i :class="expanded ? 'ri-arrow-down-s-line' : 'ri-arrow-right-s-line'" class="text-[16px]" />
      </button>
      <span class="text-[10.5px] font-mono px-1.5 py-0.5 rounded shrink-0"
        :class="isDark ? 'bg-d4 text-wt-sub' : 'bg-l4 text-lt-aux'">{{ m.id }}</span>
      <span class="text-[13px] font-medium truncate" :class="isDark ? 'text-wt-main' : 'text-lt-main'">{{ m.name }}</span>
      <span v-if="m.capabilities.generation" class="text-[10px] px-1.5 py-0.5 rounded shrink-0 font-medium text-sky-400 bg-sky-400/8">生图</span>
      <span v-if="m.capabilities.edit" class="text-[10px] px-1.5 py-0.5 rounded shrink-0 font-medium text-violet-400 bg-violet-400/8">编辑</span>
      <div class="flex-1" />
      <label class="img-switch sm" :class="m.enabled ? 'on' : ''">
        <input type="checkbox" :checked="m.enabled" @change="toggleEnabled">
        <span class="slider" :style="m.enabled ? { background: accentHex } : null" />
      </label>
      <button class="w-7 h-7 rounded grid place-items-center text-red-400 hover:bg-red-400/8 shrink-0 transition-colors"
        @click="emit('remove')">
        <i class="ri-delete-bin-line text-[13px]" />
      </button>
    </div>

    <div v-show="expanded" class="px-3 pb-3 pt-2 border-t" :class="isDark ? 'border-d4' : 'border-bdrL'">
      <div class="grid grid-cols-2 gap-x-5 gap-y-3 pt-2">
        <div>
          <label class="block text-[11px] mb-1.5 font-medium" :class="isDark ? 'text-wt-sub' : 'text-lt-sub'">能力</label>
          <div class="flex gap-2">
            <button
              class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[12px] font-medium transition-all"
              :class="m.capabilities.generation
                ? 'text-sky-400 bg-sky-400/8 border-sky-400/40'
                : (isDark ? 'text-wt-dim bg-d2 border-d4' : 'text-lt-aux bg-l2 border-bdrL')"
              @click="toggleCap('generation')">
              <i :class="m.capabilities.generation ? 'ri-checkbox-circle-fill' : 'ri-checkbox-blank-circle-line'" class="text-[13px]" />
              生图
            </button>
            <button
              class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[12px] font-medium transition-all"
              :class="m.capabilities.edit
                ? 'text-violet-400 bg-violet-400/8 border-violet-400/40'
                : (isDark ? 'text-wt-dim bg-d2 border-d4' : 'text-lt-aux bg-l2 border-bdrL')"
              @click="toggleCap('edit')">
              <i :class="m.capabilities.edit ? 'ri-checkbox-circle-fill' : 'ri-checkbox-blank-circle-line'" class="text-[13px]" />
              编辑
            </button>
          </div>
        </div>
        <div>
          <label class="block text-[11px] mb-1.5 font-medium" :class="isDark ? 'text-wt-sub' : 'text-lt-sub'">单次最大张数</label>
          <input type="number" :value="m.maxImages" @change="e => setMax(e.target.value)" min="1" max="20"
            class="w-[120px] h-8 rounded-md px-2 text-[12px] border outline-none transition-colors"
            :class="inputCls" />
        </div>
        <div>
          <label class="block text-[11px] mb-1.5 font-medium" :class="isDark ? 'text-wt-sub' : 'text-lt-sub'">尺寸模式</label>
          <OptionSelector :model-value="m.sizeMode" @update:model-value="setSizeMode"
            :options="sizeModeOptions" :is-dark="isDark" default-accent="sky"
            size="compact" trigger-class="w-[140px] h-8" />
        </div>
        <div>
          <label class="block text-[11px] mb-1.5 font-medium" :class="isDark ? 'text-wt-sub' : 'text-lt-sub'">默认比例</label>
          <OptionSelector :model-value="m.defaultSize" @update:model-value="setDefaultSize"
            :options="defaultSizeOptions" :is-dark="isDark" default-accent="sky"
            size="compact" trigger-class="w-[140px] h-8" />
        </div>
      </div>

      <div class="mt-3">
        <div class="flex items-center gap-1.5 mb-1.5">
          <span class="text-[11px] font-medium" :class="isDark ? 'text-wt-sub' : 'text-lt-sub'">支持的尺寸/比例</span>
          <button class="text-[11px] px-1.5 py-0.5 rounded border transition-colors"
            :class="isDark ? 'border-d4 hover:bg-d3' : 'border-bdrL hover:bg-l3'" :style="{ color: accentHex }"
            @click="addSize"><i class="ri-add-line" /> 添加</button>
        </div>
        <div v-for="(s, i) in m.sizes" :key="i" class="flex items-center gap-2 mb-1.5">
          <input :value="s.ratio" @input="e => setSizeRatio(i, e.target.value)"
            class="w-[120px] h-8 rounded-md px-2 text-[12px] border outline-none transition-colors"
            :class="inputCls" placeholder="比例 16:9" />
          <input :value="s.value" @input="e => setSizeValue(i, e.target.value)"
            class="flex-1 h-8 rounded-md px-2 text-[12px] border outline-none transition-colors"
            :class="inputCls" placeholder="格式原生值 如 1792x1024 / 1280*720 / 16:9" />
          <button class="w-8 h-8 rounded-md grid place-items-center text-red-400 hover:bg-red-400/8 shrink-0 transition-colors"
            @click="delSize(i)"><i class="ri-delete-bin-line text-[13px]" /></button>
        </div>
        <p v-if="!m.sizes || !m.sizes.length" class="text-[11px]" :class="isDark ? 'text-wt-dim' : 'text-lt-aux'">
          {{ m.sizeMode === 'free' ? '自由模式：调用层按范围图校验。' : '暂无尺寸预设。' }}
        </p>
      </div>

      <div class="mt-3 pt-3 border-t" :class="isDark ? 'border-d4' : 'border-bdrL'">
        <div class="flex items-center gap-1.5 mb-1.5">
          <span class="text-[11px] font-medium" :class="isDark ? 'text-wt-sub' : 'text-lt-sub'">模型自定义参数</span>
          <button class="text-[11px] px-1.5 py-0.5 rounded border transition-colors"
            :class="isDark ? 'border-d4 hover:bg-d3' : 'border-bdrL hover:bg-l3'" :style="{ color: accentHex }"
            @click="addParam"><i class="ri-add-line" /> 添加</button>
        </div>
        <div v-for="(pv, pk) in m.customParams" :key="pk" class="flex items-center gap-2 mb-1.5">
          <input :value="pk" @change="e => renParam(pk, e)"
            class="w-[170px] h-8 rounded-md px-2 text-[12px] border outline-none transition-colors"
            :class="inputCls" placeholder="key 如 quality" />
          <input v-model="m.customParams[pk]"
            class="flex-1 h-8 rounded-md px-2 text-[12px] border outline-none transition-colors"
            :class="inputCls" placeholder="value 如 high" />
          <button class="w-8 h-8 rounded-md grid place-items-center text-red-400 hover:bg-red-400/8 shrink-0 transition-colors"
            @click="delParam(pk)"><i class="ri-delete-bin-line text-[13px]" /></button>
        </div>
        <p v-if="!m.customParams || !Object.keys(m.customParams).length" class="text-[11px]"
          :class="isDark ? 'text-wt-dim' : 'text-lt-aux'">
          暂无。可添加覆盖该模型的请求参数。
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.img-switch { position: relative; width: 32px; height: 18px; display: inline-block; flex: none; }
.img-switch input { opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; position: absolute; inset: 0; }
.img-switch .slider { position: absolute; inset: 0; background: var(--ui-bg-4); border-radius: 20px; transition: background-color .15s; }
.img-switch .slider::before { content: ''; position: absolute; width: 14px; height: 14px; left: 2px; top: 2px; background: #fff; border-radius: 50%; transition: transform .15s; }
.img-switch input:checked + .slider::before { transform: translateX(14px); }
@media (prefers-reduced-motion: reduce) { .img-switch .slider, .img-switch .slider::before { transition: none; } }
</style>
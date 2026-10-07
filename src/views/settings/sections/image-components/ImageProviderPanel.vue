<script setup>
import { ref, computed, watch } from 'vue'
import { useImageModelsStore, IMAGE_API_FORMATS } from '@/stores/imageModels'
import OptionSelector from '@/components/OptionSelector.vue'
import ImageModelCard from './ImageModelCard.vue'

const props = defineProps({
  providerId: { type: String, default: null },
  isDark: { type: Boolean, default: false },
  accentHex: { type: String, default: '#4A6CFF' },
  saving: { type: Boolean, default: false },
  fetching: { type: Boolean, default: false },
})
const emit = defineEmits(['toggle-enabled', 'fetch-models', 'add-model', 'remove-provider', 'save'])

const store = useImageModelsStore()
const showApiKey = ref(false)
const expanded = ref({})

const provider = computed(() => store.getProvider(props.providerId))
const isBuiltin = computed(() => !!provider.value?.builtin)
const formatOptions = IMAGE_API_FORMATS.map(f => ({ value: f.value, label: f.label, description: f.desc }))
const canFetch = computed(() => provider.value?.apiFormat === 'openai_images' && store.providerConfiguredById(props.providerId))

watch(() => props.providerId, () => {
  showApiKey.value = false
  expanded.value = {}
})

const inputCls = computed(() =>
  props.isDark
    ? 'bg-d2 border-d4 text-wt-main placeholder-wt-dim focus:border-sky-400/40'
    : 'bg-l2 border-bdrL text-lt-main placeholder-lt-aux focus:border-sky-400'
)

function addPParam() {
  if (!provider.value) return
  if (!provider.value.customParams) provider.value.customParams = {}
  provider.value.customParams[''] = ''
}
function delPParam(k) { delete provider.value.customParams[k] }
function renPParam(oldK, e) {
  const v = provider.value.customParams[oldK]
  delete provider.value.customParams[oldK]
  provider.value.customParams[e.target.value] = v
}

function toggleExpand(id) { expanded.value[id] = !expanded.value[id] }
function isExpanded(id) { return !!expanded.value[id] }
function removeModel(mid) { store.removeModelFromProvider(props.providerId, mid) }
</script>

<template>
  <div v-if="provider" class="flex-1 min-w-0 flex flex-col" :class="isDark ? 'bg-d1' : 'bg-l1'">
    <!-- header with actions -->
    <div class="px-5 py-3 shrink-0 border-b" :class="isDark ? 'border-d4' : 'border-bdrL'">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 overflow-hidden"
          :class="isDark ? 'bg-d3' : 'bg-l3'">
          <SvgIcon :icon-class="provider.iconName || 'wand-magic-sparkles'" :size="28" />
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <span class="text-[15px] font-semibold" :class="isDark ? 'text-wt-main' : 'text-lt-main'">{{ provider.name }}</span>
            <span v-if="provider.builtin" class="text-[10px] px-1.5 py-0.5 rounded"
              :class="isDark ? 'bg-d3 text-wt-dim' : 'bg-l3 text-lt-aux'">内置</span>
            <span v-if="provider.configured" class="flex items-center gap-0.5 text-[10px] text-emerald-400">
              <i class="ri-checkbox-circle-fill text-[11px]" /> 已配置
            </span>
            <span v-else class="flex items-center gap-0.5 text-[10px] text-amber-400">
              <i class="ri-error-warning-line text-[11px]" /> 未配置
            </span>
          </div>
          <p class="text-[11.5px] mt-0.5 truncate" :class="isDark ? 'text-wt-dim' : 'text-lt-aux'">{{ provider.desc || provider.baseUrl }}</p>
        </div>
        <!-- action buttons -->
        <button v-if="!isBuiltin"
          class="h-8 px-2.5 rounded-md text-[11.5px] font-medium border border-red-400/20 text-red-400 hover:bg-red-400/8 transition-colors shrink-0"
          @click="emit('remove-provider')">
          <i class="ri-delete-bin-line text-[12px]" /> 删除
        </button>
        <button
          class="h-7 px-3 rounded-md text-[12px] font-medium text-white flex items-center gap-1 transition-opacity shrink-0"
          :style="{ background: accentHex }"
          :disabled="saving"
          :class="{ 'opacity-50 cursor-not-allowed': saving }"
          @click="emit('save')">
          <i :class="saving ? 'ri-loader-4-line animate-spin' : 'ri-save-3-line'" class="text-[14px]" />
          {{ saving ? '保存中' : '保存' }}
        </button>
        <label class="img-switch" :class="provider.enabled ? 'on' : ''">
          <input type="checkbox" :checked="provider.enabled" @change="emit('toggle-enabled', provider)">
          <span class="slider" :style="provider.enabled ? { background: accentHex } : null" />
        </label>
      </div>
    </div>

    <!-- content -->
    <div class="flex-1 overflow-y-auto px-5 py-4 space-y-4">
      <!-- connection card -->
      <div class="rounded-xl border p-4" :class="isDark ? 'border-d4 bg-d2' : 'border-bdrL bg-l2'">
        <div class="flex items-center gap-2 mb-3">
          <i class="ri-link text-[14px] text-sky-400" />
          <span class="text-[13px] font-semibold" :class="isDark ? 'text-wt-main' : 'text-lt-main'">连接配置</span>
        </div>
        <div class="space-y-3">
          <div v-if="!isBuiltin">
            <label class="block text-[11px] mb-1.5 font-medium" :class="isDark ? 'text-wt-sub' : 'text-lt-sub'">API 格式</label>
            <OptionSelector
              :model-value="provider.apiFormat"
              @update:model-value="v => store.updateProvider(props.providerId, { apiFormat: v })"
              :options="formatOptions" :is-dark="isDark"
              default-accent="sky" size="compact" trigger-class="w-full h-9" />
          </div>
          <div>
            <label class="block text-[11px] mb-1.5 font-medium" :class="isDark ? 'text-wt-sub' : 'text-lt-sub'">Base URL</label>
            <input :value="provider.baseUrl"
              @input="e => store.updateProvider(props.providerId, { baseUrl: e.target.value })"
              class="w-full h-8 rounded-sm px-3 text-[13px] border outline-none transition-colors"
              :class="inputCls" placeholder="https://api.example.com/v1" />
          </div>
          <div>
            <label class="block text-[11px] mb-1.5 font-medium" :class="isDark ? 'text-wt-sub' : 'text-lt-sub'">API Key</label>
            <div class="relative">
              <input :value="provider.apiKey"
                :type="showApiKey ? 'text' : 'password'"
                @input="e => store.updateProvider(props.providerId, { apiKey: e.target.value })"
                class="w-full h-8 rounded-sm px-3 pr-9 text-[13px] border outline-none transition-colors"
                :class="inputCls" placeholder="sk-..." />
              <button
                class="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 grid place-items-center rounded transition-colors"
                :class="isDark ? 'text-wt-dim hover:text-wt-main hover:bg-d3' : 'text-lt-aux hover:text-lt-main hover:bg-l3'"
                @click="showApiKey = !showApiKey">
                <i :class="showApiKey ? 'ri-eye-off-line' : 'ri-eye-line'" class="text-[14px]" />
              </button>
            </div>
          </div>
          <div>
            <div class="flex items-center gap-1.5 mb-1.5">
              <span class="text-[11px] font-medium" :class="isDark ? 'text-wt-sub' : 'text-lt-sub'">服务商自定义参数</span>
              <button class="text-[11px] px-1.5 py-0.5 rounded border transition-colors"
                :class="isDark ? 'border-d4 hover:bg-d3' : 'border-bdrL hover:bg-l3'" :style="{ color: accentHex }"
                @click="addPParam"><i class="ri-add-line" /> 添加</button>
            </div>
            <div v-for="(pv, pk) in provider.customParams" :key="pk" class="flex items-center gap-2 mb-1.5">
              <input :value="pk" @change="e => renPParam(pk, e)"
                class="w-[160px] h-8 rounded-md px-2 text-[12px] border outline-none transition-colors"
                :class="inputCls" placeholder="key" />
              <input v-model="provider.customParams[pk]"
                class="flex-1 h-8 rounded-md px-2 text-[12px] border outline-none transition-colors"
                :class="inputCls" placeholder="value" />
              <button class="w-8 h-8 rounded-md grid place-items-center text-red-400 hover:bg-red-400/8 shrink-0 transition-colors"
                @click="delPParam(pk)"><i class="ri-delete-bin-line text-[13px]" /></button>
            </div>
            <p v-if="!provider.customParams || !Object.keys(provider.customParams).length"
              class="text-[11px]" :class="isDark ? 'text-wt-dim' : 'text-lt-aux'">
              暂无。可添加覆盖该服务商所有模型的请求参数。
            </p>
          </div>
        </div>
      </div>

      <!-- model list section -->
      <div>
        <div class="flex items-center gap-2 mb-3">
          <i class="ri-stack-line text-[14px] text-sky-400" />
          <span class="text-[13px] font-semibold" :class="isDark ? 'text-wt-main' : 'text-lt-main'">模型列表</span>
          <span class="text-[11px] px-1.5 py-0.5 rounded"
            :class="isDark ? 'bg-d3 text-wt-dim' : 'bg-l3 text-lt-aux'">{{ provider.models.length }}</span>
          <div class="flex-1" />
          <button v-if="canFetch"
            class="flex items-center gap-1 px-2.5 py-1 rounded-md border text-[11px] font-medium transition-colors"
            :class="isDark ? 'border-d4 text-wt-sub hover:bg-d3' : 'border-bdrL text-lt-sub hover:bg-l3'"
            :disabled="fetching"
            @click="emit('fetch-models')">
            <i :class="fetching ? 'ri-loader-4-line animate-spin' : 'ri-download-cloud-2-line'" class="text-[13px]" />
            {{ fetching ? '拉取中...' : '拉取模型' }}
          </button>
          <button
            class="flex items-center gap-1 px-2.5 py-1 rounded-sm text-[11px] font-medium text-white transition-opacity"
            :style="{ background: accentHex }"
            @click="emit('add-model')">
            <i class="ri-add-line text-[13px]" /> 添加模型
          </button>
        </div>
        <div class="space-y-2">
          <ImageModelCard
            v-for="m in provider.models" :key="m.id"
            :provider-id="providerId" :model="m"
            :is-dark="isDark" :accent-hex="accentHex"
            :expanded="isExpanded(m.id)"
            @toggle-expand="toggleExpand(m.id)"
            @remove="removeModel(m.id)" />
        </div>
        <div v-if="!provider.models.length"
          class="text-center py-10 rounded-xl border border-dashed"
          :class="isDark ? 'border-d4' : 'border-bdrL'">
          <i class="ri-image-add-line text-[28px]" :class="isDark ? 'text-wt-dim' : 'text-lt-aux'" />
          <p class="text-[12px] mt-2" :class="isDark ? 'text-wt-dim' : 'text-lt-aux'">
            暂无模型，点击「添加模型」或「拉取模型」
          </p>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.img-switch { position: relative; width: 38px; height: 21px; display: inline-block; flex: none; }
.img-switch input { opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; position: absolute; inset: 0; }
.img-switch .slider { position: absolute; inset: 0; background: var(--ui-bg-4); border-radius: 20px; transition: background-color .15s; }
.img-switch .slider::before { content: ''; position: absolute; width: 17px; height: 17px; left: 2px; top: 2px; background: #fff; border-radius: 50%; transition: transform .15s; }
.img-switch input:checked + .slider::before { transform: translateX(17px); }
@keyframes imgspin { to { transform: rotate(360deg); } }
.animate-spin { animation: imgspin 1s linear infinite; }
@media (prefers-reduced-motion: reduce) { .img-switch .slider, .img-switch .slider::before { transition: none; } .animate-spin { animation: none; } }
</style>
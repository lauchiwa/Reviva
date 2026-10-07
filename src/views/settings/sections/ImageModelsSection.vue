<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useAppStore } from '@/stores/app'
import { useSettingsStore } from '@/stores/settings'
import { useImageModelsStore } from '@/stores/imageModels'
import { useMessage } from '@/components/MsMessage/useMessage'
import ImageDefaultBar from './image-components/ImageDefaultBar.vue'
import ImageProviderRail from './image-components/ImageProviderRail.vue'
import ImageProviderPanel from './image-components/ImageProviderPanel.vue'
import ImageAddProviderModal from './image-components/ImageAddProviderModal.vue'
import ImageAddModelModal from './image-components/ImageAddModelModal.vue'

const appStore = useAppStore()
const settingsStore = useSettingsStore()
const store = useImageModelsStore()
const msg = useMessage()
const isDark = computed(() => appStore.isDark)
const accentHex = computed(() => settingsStore.currentAccentHex)

const selectedId = ref(null)
const saving = ref(false)
const fetching = ref(false)
const fetchError = ref(null)
const showAddProvider = ref(false)
const showAddModel = ref(false)

const showFetchModal = ref(false)
const fetchedModels = ref([])
const fetchSelectedIds = ref([])
const fetchSearchQuery = ref('')

watch(showFetchModal, visible => { if (!visible) { fetchSelectedIds.value = []; fetchSearchQuery.value = '' } })

const existingModelIds = computed(() => {
  const p = store.getProvider(selectedId.value)
  return p ? (p.models || []).map(m => m.id) : []
})
const filteredFetchedModels = computed(() => {
  const q = fetchSearchQuery.value.trim().toLowerCase()
  if (!q) return fetchedModels.value
  return fetchedModels.value.filter(m => (m.id || '').toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q))
})

onMounted(async () => {
  await store.loadFromDb()
  const first = store.providers.find(p => p.enabled) || store.providers[0]
  if (first) selectedId.value = first.id
})

const selectedProviderName = computed(() => store.getProvider(selectedId.value)?.name || '')

function selectProvider(id) {
  selectedId.value = id
  fetchError.value = null
}

async function toggleEnabled(p) {
  store.updateProvider(p.id, { enabled: !p.enabled })
  await store.saveProviders()
}

async function saveAll() {
  saving.value = true
  const minDelay = new Promise(r => setTimeout(r, 2000))
  try {
    await Promise.all([
      store.saveProviders(),
      store.saveDefaultModels(),
      minDelay,
    ])
    msg.success('已保存')
  } catch (e) {
    await minDelay
    msg.error('保存失败：' + (e?.message || e))
  } finally {
    saving.value = false
  }
}

async function fetchModels() {
  const p = store.getProvider(selectedId.value)
  if (!p) return
  fetching.value = true
  fetchError.value = null
  try {
    const result = await window.electronAPI?.models?.fetchList(p.id, p.apiKey, p.baseUrl, 'openai')
    if (!result) {
      fetchError.value = 'API 不可用'
    } else if (result.success) {
      fetchedModels.value = result.models || []
      fetchSelectedIds.value = []
      fetchSearchQuery.value = ''
      showFetchModal.value = true
    } else {
      fetchError.value = result.error || '获取失败'
    }
  } catch (e) {
    fetchError.value = e?.message || String(e)
  } finally {
    fetching.value = false
  }
}

function toggleFetchSelect(modelId) {
  const idx = fetchSelectedIds.value.indexOf(modelId)
  if (idx >= 0) fetchSelectedIds.value = [...fetchSelectedIds.value.slice(0, idx), ...fetchSelectedIds.value.slice(idx + 1)]
  else fetchSelectedIds.value = [...fetchSelectedIds.value, modelId]
}

function confirmFetchAdd() {
  if (fetchSelectedIds.value.length === 0) return
  let added = 0
  for (const m of fetchedModels.value) {
    if (!fetchSelectedIds.value.includes(m.id)) continue
    if (existingModelIds.value.includes(m.id)) continue
    const r = store.addModelToProvider(selectedId.value, {
      id: m.id,
      name: m.name || m.id,
      enabled: true,
      capabilities: { generation: true, edit: false },
      sizeMode: 'free',
      sizes: [],
      maxImages: 1,
    })
    if (!r?.error) added++
  }
  showFetchModal.value = false
  if (added) msg.success(`已添加 ${added} 个模型`)
}

function confirmAddProvider(form) {
  const r = store.addProvider({
    name: form.name,
    baseUrl: form.baseUrl,
    apiFormat: form.apiFormat,
    enabled: true,
  })
  if (r?.error) { msg.error(r.error); return }
  selectedId.value = r.id
  msg.success('已添加')
}

function confirmAddModel(form) {
  const r = store.addModelToProvider(selectedId.value, {
    id: form.id,
    name: form.name,
    capabilities: { generation: form.generation, edit: form.edit },
    sizeMode: form.sizeMode,
    sizes: form.sizes,
    maxImages: form.maxImages,
  })
  if (r?.error) { msg.error(r.error); return }
  msg.success('已添加模型')
}

function removeProvider() {
  if (!selectedId.value) return
  store.removeProvider(selectedId.value)
  const next = store.providers.find(p => p.enabled) || store.providers[0]
  selectedId.value = next ? next.id : null
  msg.success('已删除')
}
</script>

<template>
  <div class="flex flex-col h-full" :class="isDark ? 'bg-d0' : 'bg-l0'">
    <div class="px-4 pt-4 shrink-0">
      <ImageDefaultBar :is-dark="isDark" :accent-hex="accentHex" />
    </div>

    <div class="flex flex-1 min-h-0 px-4 py-4">
      <ImageProviderRail
        :providers="store.providers"
        :selected-id="selectedId"
        :is-dark="isDark"
        :accent-hex="accentHex"
        @select="selectProvider"
        @add="showAddProvider = true" />

      <ImageProviderPanel
        v-if="selectedId"
        :provider-id="selectedId"
        :is-dark="isDark"
        :accent-hex="accentHex"
        :saving="saving"
        :fetching="fetching"
        @toggle-enabled="toggleEnabled"
        @fetch-models="fetchModels"
        @add-model="showAddModel = true"
        @remove-provider="removeProvider"
        @save="saveAll" />

      <div v-else class="flex-1 grid place-items-center" :class="isDark ? 'bg-d1' : 'bg-l1'">
        <div class="text-center">
          <i class="ri-image-line text-[40px]" :class="isDark ? 'text-wt-dim' : 'text-lt-aux'" />
          <p class="mt-2 text-[13px]" :class="isDark ? 'text-wt-dim' : 'text-lt-aux'">
            选左侧服务商，或添加一个自定义服务商
          </p>
        </div>
      </div>
    </div>

    <div v-if="fetchError" class="px-4 pb-2 shrink-0">
      <div class="flex items-center gap-2 px-3 py-2 rounded-lg border border-red-400/20 bg-red-400/8 text-red-400 text-[12px]">
        <i class="ri-error-warning-line text-[14px]" />
        <span class="truncate">{{ fetchError }}</span>
        <button class="ml-auto text-[11px] underline" @click="fetchError = null">关闭</button>
      </div>
    </div>

    <ImageAddProviderModal
      :show="showAddProvider"
      :is-dark="isDark"
      :accent-hex="accentHex"
      @update:show="v => showAddProvider = v"
      @confirm="confirmAddProvider" />

    <ImageAddModelModal
      :show="showAddModel"
      :is-dark="isDark"
      :accent-hex="accentHex"
      :provider-name="selectedProviderName"
      @update:show="v => showAddModel = v"
      @confirm="confirmAddModel" />

    <Teleport to="body">
      <div v-if="showFetchModal" class="modal-overlay" @click.self="showFetchModal = false">
        <div class="modal-dialog" :class="isDark ? 'modal-dialog--dark' : 'modal-dialog--light'">
          <div class="modal-head">
            <h3 :class="isDark ? 'text-wt-main' : 'text-lt-main'">获取模型列表</h3>
            <button class="modal-close" :class="isDark ? 'text-wt-sub' : 'text-lt-sub'" @click="showFetchModal = false"><i class="ri-close-line" /></button>
          </div>
          <div class="modal-body">
            <div class="space-y-3">
              <p class="text-[12px]" :class="isDark ? 'text-wt-sub' : 'text-lt-sub'">
                从 {{ selectedProviderName }} 获取到 {{ fetchedModels.length }} 个模型，选择要添加的模型：
              </p>
              <div class="relative">
                <i class="ri-search-line absolute left-2.5 top-[8px] text-[12px]" :class="isDark ? 'text-wt-dim' : 'text-lt-aux'" />
                <input v-model="fetchSearchQuery" type="text" placeholder="搜索模型..."
                  class="w-full h-8 rounded-lg py-0 pl-7 pr-2 text-[12px] outline-none transition-colors"
                  :class="isDark ? 'bg-d2 border border-d4 text-wt-sub placeholder-wt-dim focus:border-sky-400/40' : 'bg-l2 border border-bdrL text-lt-sub placeholder-lt-aux focus:border-sky-400'" />
              </div>
              <div class="max-h-[300px] overflow-y-auto space-y-0.5">
                <div v-for="model in filteredFetchedModels" :key="model.id"
                  class="flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-colors"
                  :class="existingModelIds.includes(model.id)
                    ? (isDark ? 'bg-white/4 text-wt-dim' : 'bg-l3/50 text-lt-aux')
                    : (fetchSelectedIds.includes(model.id)
                      ? (isDark ? 'bg-sky-400/8' : 'bg-sky-50')
                      : (isDark ? 'hover:bg-white/4' : 'hover:bg-l4'))"
                  @click="!existingModelIds.includes(model.id) && toggleFetchSelect(model.id)">
                  <div class="w-5 h-5 rounded-md border flex items-center justify-center shrink-0"
                    :class="existingModelIds.includes(model.id)
                      ? (isDark ? 'bg-d4 border-d4' : 'bg-l4 border-l4')
                      : (fetchSelectedIds.includes(model.id)
                        ? 'border-0'
                      : (isDark ? 'border-d4' : 'border-bdrF'))"
                    :style="fetchSelectedIds.includes(model.id) && !existingModelIds.includes(model.id) ? { background: accentHex, borderColor: accentHex } : null">
                    <i v-if="fetchSelectedIds.includes(model.id) && !existingModelIds.includes(model.id)" class="ri-check-line text-[12px] text-white" />
                    <i v-else-if="existingModelIds.includes(model.id)" class="ri-check-line text-[12px]" :class="isDark ? 'text-wt-dim' : 'text-lt-aux'" />
                  </div>
                  <span class="flex-1 min-w-0 truncate text-[12px] font-mono" :class="isDark ? 'text-wt-sub' : 'text-lt-sub'">{{ model.id }}</span>
                  <span v-if="existingModelIds.includes(model.id)" class="text-[10px] px-1.5 py-0.5 rounded shrink-0"
                    :class="isDark ? 'bg-d4 text-wt-dim' : 'bg-l4 text-lt-aux'">已添加</span>
                </div>
                <div v-if="filteredFetchedModels.length === 0" class="text-center py-6">
                  <span class="text-[12px]" :class="isDark ? 'text-wt-dim' : 'text-lt-aux'">无匹配模型</span>
                </div>
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <div class="flex-1 text-[11px]" :style="{ color: accentHex }">
              <span v-if="fetchSelectedIds.length > 0">已选择 {{ fetchSelectedIds.length }} 个模型</span>
            </div>
            <button class="h-9 px-4 rounded-lg text-[12px] font-medium border transition-colors"
              :class="isDark ? 'border-d4 text-wt-sub hover:bg-d2' : 'border-bdrL text-lt-sub hover:bg-l2'"
              @click="showFetchModal = false">取消</button>
            <button class="h-9 px-4 rounded-lg text-[12px] font-medium text-white transition-opacity"
              :style="{ background: accentHex }"
              :disabled="fetchSelectedIds.length === 0"
              :class="{ 'opacity-50 cursor-not-allowed': fetchSelectedIds.length === 0 }"
              @click="confirmFetchAdd">添加选中 ({{ fetchSelectedIds.length }})</button>
          </div>
        </div>
      </div>
   </Teleport>
 </div>
</template>

<style scoped>
.modal-overlay { position: fixed; inset: 0; z-index: 9999; display: grid; place-items: center; background: rgba(0,0,0,.4); backdrop-filter: blur(2px); }
.modal-dialog { width: min(480px, 92vw); max-height: 80vh; overflow-y: auto; border-radius: 14px; border: 1px solid rgba(128,140,160,.15); box-shadow: 0 20px 60px rgba(0,0,0,.3); }
.modal-dialog--dark { background: #1a1a2e; border-color: rgba(255,255,255,.1); color: rgba(255,255,255,.85); }
.modal-dialog--light { background: #fff; color: #1a1a2e; }
.modal-head { padding: 14px 18px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid rgba(128,140,160,.1); }
.modal-head h3 { margin: 0; font-size: 14px; font-weight: 700; }
.modal-close { width: 28px; height: 28px; flex: none; display: grid; place-items: center; border: 0; border-radius: 7px; background: transparent; cursor: pointer; font-size: 18px; opacity: .5; }
.modal-close:hover { background: rgba(128,140,160,.1); opacity: 1; }
.modal-body { padding: 16px 18px; display: flex; flex-direction: column; gap: 14px; }
.modal-footer { padding: 12px 18px; display: flex; justify-content: flex-end; gap: 8px; border-top: 1px solid rgba(128,140,160,.1); }
</style>

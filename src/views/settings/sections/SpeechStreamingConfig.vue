<script setup>
import { computed } from 'vue'

const props = defineProps({
  form: { type: Object, required: true },
  providerId: { type: String, required: true },
  isDark: { type: Boolean, default: false },
  accentHex: { type: String, default: '#4A6CFF' },
})

const streaming = computed(() => props.form?.streaming || {})
const customParams = computed(() => props.form?.customParams || {})

function toggleEnabled() {
  if (!props.form.streaming) props.form.streaming = { enabled: false }
  props.form.streaming.enabled = !props.form.streaming.enabled
}

function addParam() {
  if (!props.form.customParams) props.form.customParams = {}
  props.form.customParams[''] = ''
}
function delParam(key) { delete props.form.customParams[key] }
function renParam(oldKey, e) {
  const v = props.form.customParams[oldKey]
  delete props.form.customParams[oldKey]
  props.form.customParams[e.target.value] = v
}

const inputCls = computed(() => props.isDark ? 'si si--d' : 'si si--l')
</script>

<template>
  <div class="sc" :class="isDark ? 'sc--d' : 'sc--l'">
    <!-- streaming toggle -->
    <div class="sc-row">
      <i class="ri-pulse-line" :style="{ color: accentHex }" />
      <span class="sc-label" :class="isDark ? 'sl--d' : 'sl--l'">支持流式</span>
      <button type="button" class="sw" :class="{ on: streaming.enabled }"
        :style="streaming.enabled ? { '--sw': accentHex } : null" @click="toggleEnabled">
        <span />
      </button>
      <span v-if="streaming.enabled" class="badge badge-on">已开启</span>
      <span v-else class="badge badge-off">关闭</span>
    </div>

    <!-- general custom params (always visible, applies to both streaming and non-streaming) -->
    <div class="params" :class="isDark ? 'params--d' : 'params--l'">
      <div class="params-head">
        <span :class="isDark ? 'fl--d' : 'fl--l'">额外参数</span>
        <button class="add-btn" :style="{ color: accentHex }" @click="addParam">
          <i class="ri-add-line" />添加
        </button>
      </div>
      <div v-for="(pv, pk) in customParams" :key="pk" class="param-row">
        <input :value="pk" @change="e => renParam(pk, e)" class="si si-key" :class="inputCls" placeholder="key 如 language" />
        <input v-model="props.form.customParams[pk]" class="si si-val" :class="inputCls" placeholder="value 如 zh" />
        <button class="del-btn" @click="delParam(pk)"><i class="ri-delete-bin-line" /></button>
      </div>
      <p v-if="!Object.keys(customParams).length" class="empty" :class="isDark ? 'fl--d' : 'fl--l'">
        暂无。额外参数会附加到所有 ASR 请求（流式与非流式共用）
      </p>
    </div>
  </div>
</template>

<style scoped>
.sc { border-radius: 8px; border: 1px solid; padding: 6px 10px; }
.sc--d { border-color: rgba(255,255,255,.07); background: rgba(255,255,255,.015); }
.sc--l { border-color: rgba(128,140,160,.1); background: rgba(128,140,160,.015); }

.sc-row { display: flex; align-items: center; gap: 6px; }
.sc-row i { font-size: 15px; flex: none; }
.sc-label { font-size: 12px; font-weight: 600; }
.sl--d { color: rgba(255,255,255,.8); }
.sl--l { color: #1E293B; }

.sw { width: 32px; height: 18px; border-radius: 10px; border: 0; cursor: pointer; position: relative; background: rgba(128,140,160,.25); transition: background-color .15s; padding: 0; flex: none; margin-left: 4px; }
.sw span { position: absolute; width: 14px; height: 14px; left: 2px; top: 2px; background: #fff; border-radius: 50%; transition: transform .15s; }
.sw.on { background: var(--sw, var(--brand)); }
.sw.on span { transform: translateX(14px); }

.badge { font-size: 9px; font-weight: 650; padding: 1px 5px; border-radius: 4px; }
.badge-on { color: #10B981; background: rgba(16,185,129,.1); }
.badge-off { color: #94A3B8; background: rgba(128,140,160,.1); }

.params { margin-top: 8px; padding-top: 8px; border-top: 1px solid; }
.params--d { border-color: rgba(255,255,255,.06); }
.params--l { border-color: rgba(128,140,160,.1); }
.params-head { display: flex; align-items: center; gap: 4px; margin-bottom: 6px; }
.params-head span, .empty { font-size: 10px; }
.fl--d { color: rgba(255,255,255,.55); }
.fl--l { color: #64748B; }

.add-btn { display: inline-flex; align-items: center; gap: 2px; font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 5px; border: 1px solid rgba(128,140,160,.15); background: transparent; cursor: pointer; }
.add-btn:hover { background: rgba(var(--brand-rgb),.07); }
.param-row { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
.si { width: 100%; height: 28px; border-radius: 6px; border: 1px solid; padding: 0 8px; font-size: 11px; outline: none; background: transparent; box-sizing: border-box; }
.si--d { border-color: rgba(255,255,255,.1); color: rgba(255,255,255,.85); background: rgba(255,255,255,.03); }
.si--d::placeholder { color: rgba(255,255,255,.25); }
.si--d:focus { border-color: rgba(var(--brand-rgb),.5); }
.si--l { border-color: rgba(18,28,45,.1); color: #1E293B; background: #fff; }
.si--l::placeholder { color: #94A3B8; }
.si--l:focus { border-color: rgba(var(--brand-rgb),.5); }
.si-key { width: 120px; flex: none; }
.si-val { flex: 1; }
.del-btn { width: 24px; height: 24px; flex: none; display: grid; place-items: center; border: 0; border-radius: 5px; background: transparent; color: #EF4444; cursor: pointer; }
.del-btn:hover { background: rgba(239,68,68,.08); }
</style>

<template>
  <div class="w-full h-full flex flex-col font-sans" :class="isDark ? 'bg-d2 text-wt-main' : 'bg-slate-50 text-zinc-900'">

    <div v-if="!flatCards.length" class="flex-1 flex items-center justify-center">
      <div class="text-center" :class="isDark ? 'text-wt-dim' : 'text-zinc-400'">
        <i class="ri-coupon-line text-5xl opacity-40" />
        <div class="mt-3 text-sm font-bold">暂无知识卡片</div>
      </div>
    </div>

    <template v-else>
      <div class="shrink-0 px-5 md:px-8 pt-4 pb-2">
        <div class="flex items-center justify-between gap-3 mb-2">
          <div class="min-w-0">
            <h2 class="text-lg md:text-xl font-black truncate" :class="isDark ? 'text-wt-main' : 'text-zinc-900'">{{ studycardData.title || '知识卡片' }}</h2>
            <div class="mt-1 text-[11px] flex items-center gap-2 flex-wrap" :class="isDark ? 'text-wt-dim' : 'text-zinc-400'">
              <span class="px-2 py-0.5 rounded-full font-bold text-[10px]" :class="isDark ? 'bg-d4 text-wt-sub' : 'bg-zinc-100 text-zinc-600'">{{ round === 1 ? '第 1 轮' : '第 2 轮复习' }}</span>
              <span v-if="round === 1 && currentSetTopic" class="px-2 py-0.5 rounded-full font-bold text-[10px]" :class="isDark ? 'bg-sky-400/12 text-sky-300' : 'bg-sky-50 text-sky-600'">{{ currentSetTopic }}</span>
            </div>
          </div>
          <div class="text-right shrink-0">
            <div class="text-[11px] font-bold" :class="isDark ? 'text-emerald-400' : 'text-emerald-600'">{{ masteredCount }}/{{ flatCards.length }}</div>
            <div class="text-[9px]" :class="isDark ? 'text-wt-dim' : 'text-zinc-400'">已掌握</div>
          </div>
        </div>
        <div v-if="round === 1" class="flex items-center gap-1.5 flex-wrap mb-2">
          <button v-for="(set, idx) in studycardData.sets" :key="idx" @click="jumpToSet(idx)" class="px-2.5 py-1 rounded-full text-[11px] font-medium transition-all" :class="isCurrentSet(idx) ? (isDark ? 'bg-amber-400/15 text-amber-300 border border-amber-400/30' : 'bg-amber-100 text-amber-700 border border-amber-200') : (isDark ? 'bg-d3 text-wt-dim border border-d4 hover:bg-d4' : 'bg-white text-zinc-500 border border-zinc-200 hover:bg-zinc-50')">{{ set.topic }}</button>
        </div>
        <div class="h-1 rounded-full overflow-hidden" :class="isDark ? 'bg-d4' : 'bg-zinc-200'">
          <div class="h-full rounded-full transition-all duration-300" :class="isDark ? 'bg-amber-400' : 'bg-amber-500'" :style="{ width: progressPercent + '%' }" />
        </div>
      </div>

      <div v-if="isRoundComplete" class="flex-1 flex items-center justify-center px-4">
        <div class="text-center max-w-md">
          <div class="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4" :class="isDark ? 'bg-emerald-400/12' : 'bg-emerald-50'">
            <i class="ri-check-double-line text-3xl" :class="isDark ? 'text-emerald-400' : 'text-emerald-600'" />
          </div>
          <h3 class="text-lg font-black mb-2" :class="isDark ? 'text-wt-main' : 'text-zinc-900'">复习完成</h3>
          <div class="flex items-center justify-center gap-4 mb-5 mt-3">
            <div class="text-center"><div class="text-xl font-black" :class="isDark ? 'text-emerald-400' : 'text-emerald-600'">{{ masteredCount }}</div><div class="text-[10px]" :class="isDark ? 'text-wt-dim' : 'text-zinc-400'">已掌握</div></div>
            <div class="w-px h-8" :class="isDark ? 'bg-d4' : 'bg-zinc-200'"></div>
            <div class="text-center"><div class="text-xl font-black" :class="isDark ? 'text-amber-400' : 'text-amber-600'">{{ learningCount }}</div><div class="text-[10px]" :class="isDark ? 'text-wt-dim' : 'text-zinc-400'">待复习</div></div>
            <div class="w-px h-8" :class="isDark ? 'bg-d4' : 'bg-zinc-200'"></div>
            <div class="text-center"><div class="text-xl font-black" :class="isDark ? 'text-wt-main' : 'text-zinc-900'">{{ flatCards.length }}</div><div class="text-[10px]" :class="isDark ? 'text-wt-dim' : 'text-zinc-400'">总卡片</div></div>
          </div>
          <button v-if="canStartRound2" @click="startRound2" class="px-5 py-2.5 rounded-xl text-[12px] font-bold text-white bg-amber-500 hover:bg-amber-600 transition-colors shadow-lg shadow-amber-500/20">开始第 2 轮复习</button>
          <p v-else class="text-[12px] font-bold" :class="isDark ? 'text-emerald-400' : 'text-emerald-600'">全部掌握</p>
        </div>
      </div>

      <div v-else class="flex-1 min-h-0 flex flex-col items-center justify-center px-4 md:px-8" @touchstart.passive="onTouchStart" @touchmove.passive="onTouchMove" @touchend="onTouchEnd">
        <div class="w-full max-w-5xl flex items-center justify-between mb-2 px-1 shrink-0">
          <span class="text-[10px] font-mono font-bold px-2 py-0.5 rounded-md" :class="isDark ? 'bg-d4 text-wt-sub' : 'bg-white text-zinc-500 shadow-sm'">{{ currentQueueIndex + 1 }} / {{ currentQueue.length }}</span>
          <div class="flex items-center gap-2">
            <span v-if="isReverse" class="px-1.5 py-0.5 rounded text-[9px] font-bold" :class="isDark ? 'bg-violet-400/12 text-violet-300' : 'bg-violet-50 text-violet-600'">反向</span>
            <span class="px-2 py-0.5 rounded-full text-[10px] font-bold flex items-center gap-1" :class="cardTypeBadgeClass"><i :class="cardTypeIcon" />{{ cardTypeLabel }}</span>
          </div>
        </div>

        <div v-if="isExam" class="w-full max-w-5xl flex-1 min-h-0 studycard-perspective cursor-pointer" @click="onCardClick">
          <div class="w-full h-full relative transition-transform duration-700 transform-style-preserve-3d" :class="{ 'rotate-y-180': isFlipped }">
            <div class="absolute inset-0 w-full h-full backface-hidden rounded-2xl border p-5 md:p-7 flex flex-col" :class="[cardAccentClass, isDark ? 'shadow-[0_8px_30px_-12px_rgba(0,0,0,0.35)]' : 'shadow-[0_8px_30px_-12px_rgba(24,24,27,0.12)]']">
              <div class="flex items-center justify-between mb-3 shrink-0">
                <span class="text-[10px] font-black tracking-wider uppercase flex items-center gap-1.5" :class="isDark ? 'text-wt-dim' : 'text-zinc-500'"><i :class="cardTypeIcon" />{{ cardTypeLabel }}</span>
                <span class="text-[10px]" :class="isDark ? 'text-wt-dim' : 'text-zinc-400'">点击翻面看答案</span>
              </div>
              <div class="flex-1 min-h-0 flex items-center justify-center text-center overflow-y-auto custom-scrollbar">
                <p class="text-lg md:text-2xl font-black leading-relaxed whitespace-pre-wrap" :class="isDark ? 'text-wt-main' : 'text-zinc-800'">{{ currentCard.front || '（空）' }}</p>
              </div>
              <div v-if="currentCard.source" class="shrink-0 mt-3 pt-2 border-t text-[10px] truncate" :class="isDark ? 'border-d4 text-wt-dim' : 'border-zinc-200 text-zinc-400'"><i class="ri-bookmark-line mr-1" />{{ currentCard.source }}</div>
            </div>
            <div class="absolute inset-0 w-full h-full backface-hidden rotate-y-180 rounded-2xl border p-5 md:p-7 flex flex-col overflow-y-auto custom-scrollbar" :class="[isDark ? 'bg-d3 border-d4' : 'bg-white border-zinc-200', isDark ? 'shadow-[0_8px_30px_-12px_rgba(0,0,0,0.35)]' : 'shadow-[0_8px_30px_-12px_rgba(24,24,27,0.12)]']">
              <div class="flex items-center justify-between mb-3 shrink-0">
                <span class="text-[10px] font-black tracking-wider uppercase flex items-center gap-1.5" :class="isDark ? 'text-emerald-400' : 'text-emerald-600'"><i class="ri-check-line" />答案</span>
                <span class="text-[10px]" :class="isDark ? 'text-wt-dim' : 'text-zinc-400'">点击返回</span>
              </div>
              <div class="flex-1 min-h-0">
                <p class="text-base md:text-xl font-bold leading-relaxed whitespace-pre-wrap mb-3" :class="isDark ? 'text-wt-main' : 'text-zinc-800'">{{ currentCard.back || '（无答案）' }}</p>
                <div v-if="currentCard.explanation" class="text-[13px] leading-relaxed whitespace-pre-wrap mt-3 pt-3 border-t" :class="isDark ? 'text-wt-sub border-d4' : 'text-zinc-600 border-zinc-100'">
                  <span class="font-bold text-[10px] uppercase tracking-wider flex items-center gap-1 mb-1" :class="isDark ? 'text-wt-dim' : 'text-zinc-400'"><i class="ri-information-line" />解析</span>
                  {{ currentCard.explanation }}
                </div>
              </div>
              <div v-if="currentCard.source" class="shrink-0 mt-3 pt-2 border-t text-[10px] truncate" :class="isDark ? 'border-d4 text-wt-dim' : 'border-zinc-100 text-zinc-400'"><i class="ri-bookmark-line mr-1" />{{ currentCard.source }}</div>
            </div>
          </div>
        </div>

        <div v-else class="w-full max-w-5xl flex-1 min-h-0 flex flex-col gap-4 overflow-y-auto custom-scrollbar">
          <div class="shrink-0 rounded-2xl border p-5 md:p-7" :class="[cardAccentClass, isDark ? 'shadow-[0_4px_20px_-8px_rgba(0,0,0,0.3)]' : 'shadow-[0_4px_20px_-8px_rgba(24,24,27,0.1)]']">
            <div class="flex items-center justify-between mb-3 shrink-0">
              <span class="text-[10px] font-black tracking-wider uppercase flex items-center gap-1.5" :class="isDark ? 'text-wt-dim' : 'text-zinc-500'"><i :class="cardTypeIcon" />{{ cardTypeLabel }}</span>
              <span v-if="isReverse" class="px-1.5 py-0.5 rounded text-[9px] font-bold" :class="isDark ? 'bg-white/8 text-violet-300' : 'bg-violet-100 text-violet-600'">反向</span>
            </div>
            <p class="text-base md:text-xl font-black leading-relaxed whitespace-pre-wrap">{{ currentCard.front || '（空）' }}</p>
            <div v-if="currentCard.source" class="shrink-0 mt-3 pt-2 border-t text-[10px] truncate" :class="isDark ? 'border-d4 text-wt-dim' : 'border-zinc-200 text-zinc-400'"><i class="ri-bookmark-line mr-1" />{{ currentCard.source }}</div>
          </div>
          <div class="flex-1 min-h-0 rounded-2xl border p-5 md:p-7 flex flex-col" :class="[isDark ? 'bg-d3 border-d4' : 'bg-white border-zinc-200', isDark ? 'shadow-[0_8px_30px_-12px_rgba(0,0,0,0.35)]' : 'shadow-[0_8px_30px_-12px_rgba(24,24,27,0.12)]']">
            <div class="flex items-center justify-between mb-3 shrink-0">
              <span class="text-[10px] font-black tracking-wider uppercase flex items-center gap-1.5" :class="cardAnswerAccentClass"><i class="ri-text-block" />内容</span>
              <button v-if="hasMasks && !allMasksRevealed" @click.stop="revealAllMasks" class="text-[10px] font-bold px-2.5 py-1 rounded-lg transition-all flex items-center gap-1" :class="isDark ? 'bg-amber-400/15 text-amber-300 hover:bg-amber-400/25' : 'bg-amber-100 text-amber-700 hover:bg-amber-200'"><i class="ri-eye-line" />全部揭示</button>
              <span v-else-if="hasMasks && allMasksRevealed" class="text-[10px] font-bold flex items-center gap-1" :class="isDark ? 'text-emerald-400' : 'text-emerald-600'"><i class="ri-check-line" />已揭示</span>
            </div>
            <div class="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
              <p class="text-base md:text-xl font-bold leading-relaxed">
                <template v-for="(seg, i) in maskSegments" :key="i">
                  <span v-if="seg.type === 'text'">{{ seg.content }}</span>
                  <button v-else @click.stop="toggleMask(i)" class="inline-block mx-0.5 px-2 py-0.5 rounded-lg font-bold transition-all relative" :class="maskClass(i)">
                    <span :class="!maskStates[i] ? 'invisible' : ''">{{ seg.content }}</span>
                    <span v-if="!maskStates[i]" class="absolute inset-0 flex items-center justify-center pointer-events-none text-[11px] opacity-50"><i class="ri-question-mark" /></span>
                  </button>
                </template>
              </p>
              <div v-if="currentCard.explanation && (allMasksRevealed || !hasMasks)" class="text-[13px] leading-relaxed whitespace-pre-wrap mt-4 pt-3 border-t" :class="isDark ? 'text-wt-sub border-d4' : 'text-zinc-600 border-zinc-100'">
                <span class="font-bold text-[10px] uppercase tracking-wider flex items-center gap-1 mb-1" :class="isDark ? 'text-wt-dim' : 'text-zinc-400'"><i class="ri-information-line" />解析</span>
                {{ currentCard.explanation }}
              </div>
            </div>
            <div v-if="currentCard.source" class="shrink-0 mt-3 pt-2 border-t text-[10px] truncate" :class="isDark ? 'border-d4 text-wt-dim' : 'border-zinc-100 text-zinc-400'"><i class="ri-bookmark-line mr-1" />{{ currentCard.source }}</div>
          </div>
        </div>

        <div class="shrink-0 flex items-center justify-center gap-2 mt-3 w-full max-w-5xl">
          <button @click.stop="prevCard" :disabled="currentQueueIndex === 0" class="px-3 py-2.5 rounded-xl border transition-all flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed" :class="isDark ? 'bg-d3 border-d4 text-wt-sub hover:bg-d4' : 'bg-white border-zinc-200 text-zinc-600 hover:bg-zinc-50'"><i class="ri-arrow-left-s-line text-lg" /></button>
          <button @click.stop="markLearning" class="flex-1 py-2.5 rounded-xl border font-bold text-[12px] flex items-center justify-center gap-1.5 transition-all" :class="cardStatus === 'learning' ? (isDark ? 'bg-amber-400/15 text-amber-300 border-amber-400/30' : 'bg-amber-100 text-amber-700 border-amber-300') : (isDark ? 'bg-d3 text-wt-sub border-d4 hover:bg-d4' : 'bg-white text-zinc-600 border-zinc-200 hover:bg-amber-50')"><i class="ri-error-warning-line" /><span>不会</span></button>
          <button @click.stop="markMastered" class="flex-1 py-2.5 rounded-xl text-white font-bold text-[12px] flex items-center justify-center gap-1.5 transition-all" :class="cardStatus === 'mastered' ? (isDark ? 'bg-emerald-500 hover:bg-emerald-600' : 'bg-emerald-600 hover:bg-emerald-700') : (isDark ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-emerald-500 hover:bg-emerald-600')"><i class="ri-check-line" /><span>会</span></button>
          <button @click.stop="nextCard" :disabled="currentQueueIndex === currentQueue.length - 1" class="px-3 py-2.5 rounded-xl border transition-all flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed" :class="isDark ? 'bg-d3 border-d4 text-wt-sub hover:bg-d4' : 'bg-white border-zinc-200 text-zinc-600 hover:bg-zinc-50'"><i class="ri-arrow-right-s-line text-lg" /></button>
        </div>

        <div class="shrink-0 flex items-center justify-center gap-4 mt-2 mb-1 text-[10px]" :class="isDark ? 'text-wt-dim' : 'text-zinc-400'">
          <span><kbd class="kbd" :class="isDark ? 'dark' : ''">Space</kbd> {{ isExam ? '翻面' : '揭示' }}</span>
          <span><kbd class="kbd" :class="isDark ? 'dark' : ''">←</kbd> <kbd class="kbd" :class="isDark ? 'dark' : ''">→</kbd> 切换</span>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'

const props = defineProps({
  data: { type: Object, default: () => ({}) },
  isDark: { type: Boolean, default: false },
})

const studycardData = computed(() => props.data?.result_json || {})
const flatCards = computed(() => {
  const sets = Array.isArray(studycardData.value.sets) ? studycardData.value.sets : []
  const cards = []
  for (const set of sets) {
    if (!Array.isArray(set?.cards)) continue
    for (const card of set.cards) {
      cards.push({ ...card, _topic: set.topic })
    }
  }
  return cards
})

const cardStatuses = reactive({})
const round = ref(1)
const currentQueueIndex = ref(0)
const isFlipped = ref(false)
const maskStates = reactive({})

function initStatuses() {
  for (const card of flatCards.value) {
    const id = card.id || ''
    if (!cardStatuses[id]) cardStatuses[id] = String(card.status || 'new')
  }
}

watch(() => flatCards.value.length, () => {
  initStatuses()
  round.value = 1
  currentQueueIndex.value = 0
  resetCardState()
}, { immediate: true })

const round1Queue = computed(() => flatCards.value)
const round2Queue = computed(() => flatCards.value.filter(c => cardStatuses[c.id] === 'learning'))
const currentQueue = computed(() => round.value === 1 ? round1Queue.value : round2Queue.value)
const currentCard = computed(() => currentQueue.value[currentQueueIndex.value] || {})
const cardStatus = computed(() => cardStatuses[currentCard.value.id] || 'new')

const isExam = computed(() => String(currentCard.value.type || '').toLowerCase() === 'exam')
const isMaskCard = computed(() => {
  const t = String(currentCard.value.type || '').toLowerCase()
  return ['concept', 'mistake', 'quick_memory'].includes(t)
})
const isReverse = computed(() => String(currentCard.value.direction || '').toLowerCase() === 'reverse')

const currentSetTopic = computed(() => currentCard.value._topic || '')
const masteredCount = computed(() => flatCards.value.filter(c => cardStatuses[c.id] === 'mastered').length)
const learningCount = computed(() => flatCards.value.filter(c => cardStatuses[c.id] === 'learning').length)
const progressPercent = computed(() => {
  if (!currentQueue.value.length) return 0
  return Math.round(((currentQueueIndex.value + 1) / currentQueue.value.length) * 100)
})

const maskSegments = computed(() => {
  const text = String(currentCard.value.back || '')
  const segments = []
  const regex = /\[\[(.+?)\]\]/g
  let lastIndex = 0
  let match
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', content: text.slice(lastIndex, match.index) })
    }
    segments.push({ type: 'mask', content: match[1] })
    lastIndex = regex.lastIndex
  }
  if (lastIndex < text.length) {
    segments.push({ type: 'text', content: text.slice(lastIndex) })
  }
  return segments
})

const hasMasks = computed(() => maskSegments.value.some(s => s.type === 'mask'))
const allMasksRevealed = computed(() => {
  if (!hasMasks.value) return true
  const maskIndices = maskSegments.value.map((s, i) => s.type === 'mask' ? i : -1).filter(i => i >= 0)
  return maskIndices.every(i => maskStates[i])
})

const isRoundComplete = computed(() => {
  if (!currentQueue.value.length) return false
  if (currentQueueIndex.value < currentQueue.value.length - 1) return false
  if (isExam.value && !isFlipped.value) return false
  if (isMaskCard.value && hasMasks.value && !allMasksRevealed.value) return false
  return true
})
const canStartRound2 = computed(() => round.value === 1 && learningCount.value > 0 && currentQueueIndex.value >= currentQueue.value.length - 1)

const cardTypeLabel = computed(() => {
  const t = String(currentCard.value.type || '').toLowerCase()
  if (t === 'concept') return '概念卡'
  if (t === 'mistake') return '易错卡'
  if (t === 'exam') return '简答题卡'
  if (t === 'quick_memory') return '记忆卡'
  return '卡片'
})

const cardTypeIcon = computed(() => {
  const t = String(currentCard.value.type || '').toLowerCase()
  if (t === 'concept') return 'ri-lightbulb-line'
  if (t === 'mistake') return 'ri-error-warning-line'
  if (t === 'exam') return 'ri-question-line'
  if (t === 'quick_memory') return 'ri-flashlight-line'
  return 'ri-coupon-line'
})

const cardTypeBadgeClass = computed(() => {
  const t = String(currentCard.value.type || '').toLowerCase()
  if (props.isDark) {
    if (t === 'concept') return 'bg-sky-400/12 text-sky-300'
    if (t === 'mistake') return 'bg-rose-400/12 text-rose-300'
    if (t === 'exam') return 'bg-emerald-400/12 text-emerald-300'
    if (t === 'quick_memory') return 'bg-violet-400/12 text-violet-300'
    return 'bg-d4 text-wt-sub'
  }
  if (t === 'concept') return 'bg-sky-50 text-sky-600'
  if (t === 'mistake') return 'bg-rose-50 text-rose-600'
  if (t === 'exam') return 'bg-emerald-50 text-emerald-600'
  if (t === 'quick_memory') return 'bg-violet-50 text-violet-600'
  return 'bg-zinc-100 text-zinc-600'
})

const cardAccentClass = computed(() => {
  const t = String(currentCard.value.type || '').toLowerCase()
  if (props.isDark) {
    if (t === 'concept') return 'bg-sky-400/10 border-sky-400/20 text-wt-main'
    if (t === 'mistake') return 'bg-rose-400/10 border-rose-400/20 text-wt-main'
    if (t === 'quick_memory') return 'bg-violet-400/10 border-violet-400/20 text-wt-main'
    if (t === 'exam') return 'bg-emerald-400/10 border-emerald-400/20 text-wt-main'
    return 'bg-d3 border-d4 text-wt-main'
  }
  if (t === 'concept') return 'bg-sky-50 border-sky-100 text-zinc-800'
  if (t === 'mistake') return 'bg-rose-50 border-rose-100 text-zinc-800'
  if (t === 'quick_memory') return 'bg-violet-50 border-violet-100 text-zinc-800'
  if (t === 'exam') return 'bg-emerald-50 border-emerald-100 text-zinc-800'
  return 'bg-white border-zinc-200 text-zinc-800'
})

const cardAnswerAccentClass = computed(() => {
  const t = String(currentCard.value.type || '').toLowerCase()
  if (props.isDark) {
    if (t === 'concept') return 'text-sky-300'
    if (t === 'mistake') return 'text-rose-300'
    if (t === 'quick_memory') return 'text-violet-300'
    return 'text-amber-300'
  }
  if (t === 'concept') return 'text-sky-600'
  if (t === 'mistake') return 'text-rose-600'
  if (t === 'quick_memory') return 'text-violet-600'
  return 'text-amber-600'
})

function maskClass(i) {
  if (maskStates[i]) {
    return props.isDark ? 'bg-amber-400/15 text-amber-200 border border-amber-400/30' : 'bg-amber-100 text-amber-800 border border-amber-200'
  }
  return props.isDark ? 'bg-d4 border border-amber-400/30 hover:border-amber-400/60 hover:bg-d3' : 'bg-zinc-200 border border-zinc-300 hover:border-amber-400 hover:bg-zinc-100'
}

function toggleMask(i) {
  maskStates[i] = !maskStates[i]
}

function revealAllMasks() {
  maskSegments.value.forEach((s, i) => {
    if (s.type === 'mask') maskStates[i] = true
  })
}

function resetCardState() {
  isFlipped.value = false
  Object.keys(maskStates).forEach(k => delete maskStates[k])
}

function isCurrentSet(setIdx) {
  if (round.value !== 1) return false
  const sets = Array.isArray(studycardData.value.sets) ? studycardData.value.sets : []
  if (!sets[setIdx]) return false
  return currentCard.value._topic === sets[setIdx].topic
}

function jumpToSet(setIdx) {
  const sets = Array.isArray(studycardData.value.sets) ? studycardData.value.sets : []
  let offset = 0
  for (let i = 0; i < setIdx; i++) {
    offset += (sets[i]?.cards?.length || 0)
  }
  resetCardState()
  currentQueueIndex.value = offset
}

function markLearning() {
  if (currentCard.value.id) cardStatuses[currentCard.value.id] = 'learning'
  advance()
}

function markMastered() {
  if (currentCard.value.id) cardStatuses[currentCard.value.id] = 'mastered'
  advance()
}

function advance() {
  if (currentQueueIndex.value < currentQueue.value.length - 1) {
    resetCardState()
    currentQueueIndex.value++
  }
}

function prevCard() {
  if (currentQueueIndex.value > 0) {
    resetCardState()
    currentQueueIndex.value--
  }
}

function nextCard() {
  if (currentQueueIndex.value < currentQueue.value.length - 1) {
    resetCardState()
    currentQueueIndex.value++
  }
}

function onCardClick() {
  if (isExam.value) {
    isFlipped.value = !isFlipped.value
  } else if (isMaskCard.value && hasMasks.value && !allMasksRevealed.value) {
    revealAllMasks()
  }
}

function startRound2() {
  round.value = 2
  currentQueueIndex.value = 0
  resetCardState()
}

let touchStartX = 0
let touchStartY = 0
let touchActive = false

function onTouchStart(e) {
  const t = e.touches[0]
  touchStartX = t.clientX
  touchStartY = t.clientY
  touchActive = true
}

function onTouchMove() {}

function onTouchEnd(e) {
  if (!touchActive) return
  touchActive = false
  const t = e.changedTouches[0]
  const dx = t.clientX - touchStartX
  const dy = t.clientY - touchStartY
  if (Math.abs(dx) < 50 || Math.abs(dy) > 60) return
  if (dx < 0) markLearning()
  else markMastered()
}

function isEditableTarget(el) {
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable
}

function handleKeydown(e) {
  if (isEditableTarget(e.target)) return
  if (e.key === 'ArrowLeft') {
    e.preventDefault()
    prevCard()
  } else if (e.key === 'ArrowRight') {
    e.preventDefault()
    if (currentQueueIndex.value < currentQueue.value.length - 1) nextCard()
  } else if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault()
    onCardClick()
  }
}

onMounted(() => window.addEventListener('keydown', handleKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', handleKeydown))

watch(() => currentQueue.value.length, () => {
  if (currentQueueIndex.value >= currentQueue.value.length) {
    currentQueueIndex.value = Math.max(0, currentQueue.value.length - 1)
  }
})
</script>

<style scoped>
.studycard-perspective { perspective: 1200px; }
.transform-style-preserve-3d { transform-style: preserve-3d; }
.rotate-y-180 { transform: rotateY(180deg); }
.backface-hidden {
  backface-visibility: hidden;
  -webkit-backface-visibility: hidden;
}
.kbd {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 10px;
  font-weight: 900;
  padding: 1px 5px;
  border-radius: 6px;
  border: 1px solid #e4e4e7;
  background: #f4f4f5;
  color: #71717a;
}
.kbd.dark {
  border-color: rgba(255, 255, 255, 0.14);
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.8);
}
.custom-scrollbar::-webkit-scrollbar { width: 6px; }
.custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
.custom-scrollbar::-webkit-scrollbar-thumb {
  background-color: rgba(245, 158, 11, 0.3);
  border-radius: 999px;
}
</style>

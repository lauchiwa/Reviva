export class StudyCardGenerationModule {
  constructor({ jsonRunner }) {
    this.toolId = 'studycard'
    this.label = '知识卡片'
    this.agentEnglishName = 'studycard-generator'
    this.supports = ['local', 'cloud']
    this.schema = 'studycard'
    this._jsonRunner = jsonRunner
  }

  canRun() {
    return true
  }

  run(request) {
    return this._jsonRunner.run({
      ...request,
      toolId: this.toolId,
      includeExternalSources: true,
      validateResult: data => this._validate(data),
    })
  }

  _validate(data) {
    if (!data || typeof data !== 'object') return { error: '返回数据不是对象' }
    if (typeof data.title !== 'string' || !data.title.trim()) return { error: '缺少 title' }
    if (!Array.isArray(data.sets) || !data.sets.length) return { error: 'sets 必须是非空数组' }

    const validTypes = ['concept', 'mistake', 'exam', 'quick_memory']
    const seenIds = new Set()

    for (const [setIdx, set] of data.sets.entries()) {
      if (!set || typeof set !== 'object') return { error: `第 ${setIdx + 1} 组不是对象` }
      if (typeof set.topic !== 'string' || !set.topic.trim()) return { error: `第 ${setIdx + 1} 组缺少 topic` }
      if (!Array.isArray(set.cards) || !set.cards.length) return { error: `第 ${setIdx + 1} 组 cards 必须是非空数组` }

      for (const [cardIdx, card] of set.cards.entries()) {
        if (!card || typeof card !== 'object') return { error: `第 ${setIdx + 1} 组第 ${cardIdx + 1} 张卡不是对象` }

        const id = String(card.id || '')
        if (!id) return { error: `第 ${setIdx + 1} 组第 ${cardIdx + 1} 张卡缺少 id` }
        if (seenIds.has(id)) return { error: `卡片 id 重复: ${id}` }
        seenIds.add(id)

        const type = String(card.type || '').toLowerCase()
        if (!validTypes.includes(type)) return { error: `第 ${setIdx + 1} 组第 ${cardIdx + 1} 张卡 type 只支持 ${validTypes.join('/')}` }

        if (!String(card.front || '').trim()) return { error: `第 ${setIdx + 1} 组第 ${cardIdx + 1} 张卡缺少 front` }
        if (!String(card.back || '').trim()) return { error: `第 ${setIdx + 1} 组第 ${cardIdx + 1} 张卡缺少 back` }

        const direction = String(card.direction || 'forward').toLowerCase()
        if (direction !== 'forward' && direction !== 'reverse') return { error: `第 ${setIdx + 1} 组第 ${cardIdx + 1} 张卡 direction 只能是 forward 或 reverse` }
      }
    }

    return { ok: true }
  }
}

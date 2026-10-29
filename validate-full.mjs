// 按 packages/session/session-format-v3-to-v4/src/relationships.ts 的规则实现的完整校验器
// 用于写盘前自检，覆盖 turn/step/tool/surface/developer/title/command/compaction

export function validateEventsFull(events, startTurn = 1) {
  const problems = []
  let turn = null
  let nextTurn = startTurn
  let step = null
  let nextStep = 1
  const tools = new Map()
  const surface = []            // surface 上的 seq 列表
  let protectedHead = null
  const commands = new Set()
  let compaction = null
  let provider = null
  const seen = new Map()        // seq -> event

  const fail = (msg) => { if (problems.length < 200) problems.push(msg) }
  const isSurfaceType = (t) => ['system/message', 'user/message', 'developer/message', 'assistant/message', 'tool/result'].includes(t)

  for (const e of events) {
    if (!e || !e.type || e.type === 'session') continue
    if (typeof e.seq === 'number') seen.set(e.seq, e)
    const d = e.data || {}

    // ==== DSH 真实会拦的字段级规则（提前在本地拦住）====
    // sourceEventSeqs 必须唯一、且都指向更早的事件
    if (Array.isArray(e.sourceEventSeqs)) {
      const uniq = new Set(e.sourceEventSeqs)
      if (uniq.size !== e.sourceEventSeqs.length) fail(`sourceEventSeqs 有重复（seq ${e.seq}）`)
      for (const s of e.sourceEventSeqs) {
        if (typeof s !== 'number' || s >= e.seq) { fail(`sourceEventSeqs 指向不早于自身（seq ${e.seq} 引用 ${s}）`); break }
      }
    }
    // user/assistant 消息必须带 producer-owned source
    if ((e.type === 'user/message' || e.type === 'assistant/message' || e.type === 'system/message' || e.type === 'developer/message')) {
      const src = e.type === 'assistant/message' ? (d.message && d.message.source) : d.source
      if (!src || typeof src !== 'object' || typeof src.kind !== 'string') {
        fail(`${e.type} 缺 producer-owned source（seq ${e.seq}）`)
      }
    }
    // assistant/message 的结构
    if (e.type === 'assistant/message') {
      if (!d.message || !Array.isArray(d.message.content)) fail(`assistant/message 缺 message.content（seq ${e.seq}）`)
      if (!Array.isArray(d.stream)) fail(`assistant/message 缺 stream 数组（seq ${e.seq}）`)
    }
    // tool/result 的 callId 在 message.source.callId
    if (e.type === 'tool/result' && e.surfaceOp === 'append') {
      const cid = d.message && d.message.source && d.message.source.callId
      if (!cid) fail(`tool/result 缺 message.source.callId（seq ${e.seq}）`)
    }
    // session/end-seed 只能有一条，且不能是 inherited（外部生成的会话 header 是 unseeded）
    if (e.type === 'session/end-seed' && d.inherited === true) {
      fail(`session/end-seed 带 inherited: true（unseeded 会话不允许，seq ${e.seq}）`)
    }

    // ==== surface 折叠 ====
    if (isSurfaceType(e.type)) {
      if (e.type === 'system/message' && surface.length > 0 && protectedHead === null) {
        fail('system/message 不在 surface 首位')
      }
      if (e.surfaceOp === 'append') {
        if (e.type === 'system/message' && surface.length === 0) protectedHead = e.seq
        surface.push(e.seq)
      } else if (e.surfaceOp && typeof e.surfaceOp === 'object') {
        const s = e.surfaceOp.startSeq
        const en = e.surfaceOp.endSeq
        const first = surface.indexOf(s)
        const last = surface.indexOf(en)
        if (first < 0 || last < first) fail(`${e.type} replacement range 不在当前 surface 上`)
        else surface.splice(first, last - first + 1, e.seq)
      }
    }

    switch (e.type) {
      case 'turn/start':
        if (turn !== null) fail('turn/start 时还有未关闭的 turn')
        if (d.turn !== nextTurn) fail(`turn/start 期望 ${nextTurn} 实际 ${d.turn}`)
        turn = nextTurn; nextStep = 1; tools.clear()
        break
      case 'turn/end':
        if (turn === null || d.turn !== turn || step !== null) fail('turn/end 不匹配打开的 turn 或无打开的 step')
        if (tools.size) fail(`turn/end 时有未结算工具 ${[...tools.keys()].join(',')}`)
        turn = null; nextTurn += 1
        break
      case 'step/start':
        if (turn === null || d.turn !== turn || step !== null || d.step !== nextStep) fail('step/start 不匹配')
        step = nextStep
        break
      case 'step/end':
        if (turn === null || step === null || d.turn !== turn || d.step !== step) fail('step/end 不匹配')
        if (tools.size) fail(`step/end 时有未结算工具 ${[...tools.keys()].join(',')}`)
        step = null; nextStep += 1
        break
      case 'assistant/message': {
        if (step === null || d.turn !== turn || d.step !== step) fail('assistant/message 不在打开的 turn/step')
        const c = d.message && d.message.content
        if (!Array.isArray(c)) fail('assistant/message 缺 message.content')
        else for (const b of c) {
          if (b && b.type === 'tool-call') {
            if (tools.has(b.id)) fail(`assistant/message 重复宣告 ${b.id}`)
            tools.set(b.id, { name: b.name, arguments: b.arguments, started: false })
          }
        }
        if (!Array.isArray(d.stream)) fail('assistant/message 缺 stream 数组')
        break
      }
      case 'tool/call': {
        const p = tools.get(d.callId)
        if (!p) fail(`tool/call ${d.callId} 没有宣告`)
        else if (p.started || p.name !== d.name || p.arguments !== d.arguments) fail(`tool/call ${d.callId} 与宣告不匹配`)
        else p.started = true
        break
      }
      case 'tool/result': {
        // 源码：surfaceOp 不是 append 的 tool/result（replace 修正）跳过配对检查
        if (e.surfaceOp !== 'append') {
          if (turn === null) fail('tool/result replace 在 turn 外')
          break
        }
        const id = d.message && d.message.toolCallId
        if (!tools.has(id)) fail(`tool/result ${id} 没有对应 tool/call`)
        tools.delete(id)
        break
      }
      case 'developer/message': {
        if (typeof d.headerSeq === 'number') {
          if (d.headerSeq >= e.seq) fail('developer/message headerSeq 必须指向更早的事件')
          else {
            const he = seen.get(d.headerSeq)
            if (!he || he.type !== 'request/header') fail('developer/message headerSeq 不是 request/header')
          }
        }
        break
      }
      case 'request/header': {
        if (turn === null) fail('request/header 在 turn 外')
        const cfg = d.header && d.header.config
        if (!cfg || typeof cfg.provider !== 'string') fail('request/header 缺 config.provider')
        else provider = cfg.provider
        break
      }
      case 'session/title': {
        const refs = Array.isArray(d.messageSeqs) ? d.messageSeqs : []
        const kind = d.source && d.source.kind
        if ((refs.length === 0) !== (kind === 'user')) fail(`session/title source(${kind}) 与 messageSeqs 数量(${refs.length}) 不配套`)
        for (const r of refs) {
          if (r >= e.seq) fail('session/title messageSeqs 必须指向更早的事件')
          else {
            const re = seen.get(r)
            if (!re || re.type !== 'user/message') fail('session/title messageSeqs 不是 user/message')
          }
        }
        break
      }
      case 'command/run': {
        const id = d.commandId
        if (id === undefined) fail('command/run 缺 commandId')
        else if (commands.has(id)) fail(`command/run 重复 commandId ${id}`)
        else commands.add(id)
        break
      }
      case 'command/done':
        if (!commands.has(d.commandId)) fail('command/done 没有对应的 command/run')
        break
      case 'compaction/start':
        if (compaction !== null) fail('compaction/start 重叠')
        if (turn === null) fail('compaction/start 在 turn 外（DSH 要求落在打开着的 turn 内）')
        else if (typeof d.turn === 'number' && d.turn !== turn) fail(`compaction/start 的 turn(${d.turn}) 与打开的 turn(${turn}) 不一致`)
        compaction = { id: d.compactionId, turn: d.turn, summarized: false }
        break
      case 'compaction/summary':
      case 'compaction/prune': {
        // DSH：summary 必须能对上已打开的 compaction/start（同 compactionId + 同 turn）
        if (e.type === 'compaction/summary') {
          if (compaction === null) fail('compaction/summary 没有对应的 compaction/start')
          else {
            if (d.compactionId !== compaction.id) fail('compaction/summary 的 compactionId 与 start 不一致')
            if (typeof d.turn === 'number' && d.turn !== compaction.turn) fail('compaction/summary 的 turn 与 start 不一致')
            compaction.summarized = true
          }
        }
        const range = d.shadowedRange
        if (!range) { fail(`${e.type} 缺 shadowedRange`); break }
        const first = surface.indexOf(range.start)
        const last = surface.indexOf(range.end)
        if (first < 0 || last < first) fail(`${e.type} shadowedRange 不在当前 surface 上`)
        else {
          const seqs = Array.isArray(d.shadowedSeqs) ? d.shadowedSeqs : []
          const actual = surface.slice(first, last + 1)
          if (seqs.length !== actual.length) fail(`${e.type} shadowedSeqs 长度与 surface 段不符 (${seqs.length} vs ${actual.length})`)
          else if (seqs.some((s, i) => s !== actual[i])) fail(`${e.type} shadowedSeqs 与 surface 段不一致`)
          if (protectedHead !== null && seqs.includes(protectedHead)) fail(`${e.type} 遮蔽了受保护的 system 头`)
          if (e.type === 'compaction/prune') {
            // prune 不移除，只记录
          }
        }
        break
      }
      case 'compaction/end':
        if (compaction === null) fail('compaction/end 没有对应的 start')
        compaction = null
        break
    }
  }

  if (turn !== null) fail('结束时还有未关闭的 turn')
  if (step !== null) fail('结束时还有未关闭的 step')
  if (tools.size) fail('结束时还有未结算工具')
  return problems
}

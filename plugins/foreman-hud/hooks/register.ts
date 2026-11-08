import type { EngineInterface, Register } from 'claude-code'

// foreman-hud: mod ส่วนตัวสำหรับ model-foreman
// - บังคับกฎ: worker ต้องระบุโมเดล, ห้ามลดระดับโมเดลของ task เดิม,
//   reviewer ต้องไม่ต่ำกว่าระดับที่ rubric กำหนด, QA เป็น Sonnet เสมอ, รีวิวไม่เกิน 5 ครั้งต่อ task
// - บันทึก log จากเหตุการณ์จริงลง .claude/foreman-log.jsonl และ .claude/router-log.md
// - แสดงสถานะใน status line และ toast

const WORKER = 'model-foreman:worker'
const REVIEWER = 'model-foreman:reviewer'
const QA = 'model-foreman:qa'
const LADDER = ['haiku', 'sonnet', 'opus'] as const
type Tier = (typeof LADDER)[number]
const MAX_REVIEWS = 5

const JSONL = '.claude/foreman-log.jsonl'
const MD = '.claude/router-log.md'
const SETTINGS = '.claude/settings.local.json'
const MODE_ON = /"outputStyle"\s*:\s*"model-foreman:/i
const MD_HEADER =
  '| วันที่ | task | คะแนน | โมเดลแรก | skill ที่ใช้ | QA | จำนวนรีวิว | โมเดลสุดท้าย | ผล | token in/out |\n' +
  '|---|---|---|---|---|---|---|---|---|---|\n'

const RESULT_TH: Record<string, string> = {
  PASS: 'ผ่าน',
  FIX: 'แก้',
  ESCALATE: 'ยกระดับ',
  ESCALATE_REVIEW: 'ส่งต่อรีวิว',
  BLOCKED: 'ติด',
  CAP: 'ชนเพดานรีวิว',
}

type Role = 'worker' | 'qa' | 'reviewer'

type Task = {
  id: string
  title: string
  score: string
  skill: string
  isHighRisk: boolean
  testsPassed?: boolean
  reviewTiers: Tier[]
  minNextReview?: Tier
  firstTier?: Tier
  lastTier?: Tier
  reviews: number
  qaRuns: number
  qaStatus?: string
  result?: string
  isClosed: boolean
  tokensIn: number
  tokensOut: number
}

type Run = { task: string; role: Role; tier: Tier; isDone: boolean }

const tierOf = (model?: string): Tier | undefined => {
  const m = (model ?? '').toLowerCase()
  return LADDER.find(t => m.includes(t))
}

const label = (t?: Tier) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : '-')

const field = (text: string, name: string) => {
  const m = text.match(new RegExp(`^\\s*${name}\\s*:\\s*(.+)$`, 'm'))
  return m?.[1]?.trim()
}

const parseTask = (prompt: string) => {
  const m = prompt.match(/TASK\s*:\s*([A-Za-z0-9_.-]+)[ \t]*(?:[—–:-][ \t]*([^\n]*))?/)
  return m?.[1] ? { id: m[1], title: (m[2] ?? '').trim() } : undefined
}


// สถานะ QA: นับว่าพบปัญหาเฉพาะเมื่อขึ้นต้นด้วย "พบปัญหา"
// ("ไม่พบปัญหา" มีคำว่า "พบปัญหา" อยู่ข้างใน ห้ามใช้ includes)
const qaFoundIssue = (status?: string) => /^\s*พบปัญหา/.test(status ?? '')

// ผล test: ผ่านเมื่อมีคำว่าผ่าน/pass และไม่มีคำว่าไม่ผ่าน/fail ที่นับได้มากกว่า 0
// ("12 passed, 0 failed" ต้องนับว่าผ่าน)
const parseTestsPassed = (line?: string): boolean | undefined => {
  const text = (line ?? '').trim()
  if (!text) return undefined
  const withoutZero = text.replace(/\b0\s*(failed|failing|failures?|fails?)\b/gi, '')
  const isFail = /ไม่ผ่าน|\bfail(ed|ing|ures?|s)?\b/i.test(withoutZero)
  const isPass = /ผ่าน|\bpass(ed|es|ing)?\b/i.test(text)
  return isPass && !isFail
}

const nextTier = (t: Tier): Tier => LADDER[Math.min(LADDER.indexOf(t) + 1, LADDER.length - 1)] ?? 'opus'

// ระดับ reviewer ขั้นต่ำตามตาราง "เลือกโมเดลของ reviewer" ใน rubric
const requiredReview = (t: Task): { tier: Tier; why: string } => {
  const score = Number.parseInt(t.score, 10)
  let need: { tier: Tier; why: string }
  if (t.isHighRisk) need = { tier: 'opus', why: 'ความเสี่ยงสูง' }
  else if (Number.isFinite(score) && score >= 7) need = { tier: 'opus', why: `คะแนน ${score}` }
  else if (t.lastTier === 'opus') need = { tier: 'opus', why: 'worker เป็น Opus' }
  else if (qaFoundIssue(t.qaStatus)) need = { tier: 'opus', why: 'QA พบปัญหา' }
  else if (Number.isFinite(score) && score <= 3 && t.testsPassed === true) need = { tier: 'haiku', why: `คะแนน ${score} และ test ผ่าน` }
  else need = { tier: 'sonnet', why: Number.isFinite(score) ? `คะแนน ${score}` : 'ไม่รู้คะแนน' }
  if (t.minNextReview && LADDER.indexOf(t.minNextReview) > LADDER.indexOf(need.tier)) {
    need = { tier: t.minNextReview, why: 'reviewer รอบก่อนส่งต่อ' }
  }
  return need
}

type State = {
  tasks: Map<string, Task>
  runs: Map<string, Run>
  isModeOn: boolean
  hasWarnedModel: boolean
  writes: Promise<void>
}

async function readOr($: EngineInterface, path: string, fallback: string) {
  try {
    const text = await $.fs.read(path)
    return typeof text === 'string' ? text : fallback
  } catch {
    return fallback
  }
}

// งานเขียนไฟล์ทั้งหมดเข้าคิวเดียว กัน worker หลายตัวเขียนชนกัน
function queue(s: State, job: () => Promise<void>) {
  s.writes = s.writes.then(job).catch(() => undefined)
  return s.writes
}

function logEvent($: EngineInterface, s: State, row: Record<string, unknown>) {
  return queue(s, async () => {
    const old = await readOr($, JSONL, '')
    await $.fs.write(JSONL, old + JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n')
  })
}

function logRow($: EngineInterface, s: State, t: Task) {
  return queue(s, async () => {
    const old = await readOr($, MD, '')
    const cells = [
      new Date().toISOString().slice(0, 10),
      `${t.id} ${t.title}`.trim(),
      t.score,
      label(t.firstTier),
      t.skill,
      t.qaRuns > 0 ? `${t.qaStatus ?? '-'} (${t.qaRuns})` : '-',
      t.reviewTiers.length > 0 ? `${t.reviews} (${t.reviewTiers.map(label).join('→')})` : String(t.reviews),
      label(t.lastTier),
      RESULT_TH[t.result ?? ''] ?? t.result ?? '-',
      `${t.tokensIn}/${t.tokensOut}`,
    ]
    const body = old.trim().length > 0 ? old.replace(/\n*$/, '\n') : MD_HEADER
    await $.fs.write(MD, body + `| ${cells.join(' | ')} |\n`)
  })
}

function closeTask($: EngineInterface, s: State, t: Task, result: string) {
  t.isClosed = true
  t.result = result
  return logRow($, s, t)
}

function refreshStatus($: EngineInterface, s: State) {
  const all = [...s.tasks.values()]
  const active = [...s.runs.values()].filter(r => !r.isDone)
  if (!s.isModeOn && all.length === 0) {
    $.ui.status(undefined)
    return
  }
  const parts = ['Foreman']
  for (const r of active) {
    const t = s.tasks.get(r.task)
    const what = r.role === 'reviewer' ? `รีวิว ${t?.reviews ?? 0}/${MAX_REVIEWS}` : r.role === 'qa' ? 'QA' : 'กำลังทำ'
    parts.push(`${r.task} ${label(r.tier)} ${what}`)
  }
  parts.push(all.length > 0 ? `เสร็จ ${all.filter(t => t.isClosed).length}/${all.length}` : 'ON')
  $.ui.status(parts.join(' · '))
}

function getTask(s: State, prompt: string) {
  const parsed = parseTask(prompt)
  if (!parsed) return undefined
  const known = s.tasks.get(parsed.id)
  if (known) return known
  const t: Task = {
    id: parsed.id,
    title: parsed.title,
    score: field(prompt, 'คะแนน') ?? '-',
    skill: field(prompt, 'SKILL ที่ต้องโหลดก่อนเริ่ม') ?? '-',
    isHighRisk: /^ใช่/.test(field(prompt, 'ความเสี่ยงสูง') ?? ''),
    reviewTiers: [],
    reviews: 0,
    qaRuns: 0,
    isClosed: false,
    tokensIn: 0,
    tokensOut: 0,
  }
  s.tasks.set(t.id, t)
  return t
}

export const register: Register = on => {
  const s: State = {
    tasks: new Map(),
    runs: new Map(),
    isModeOn: false,
    hasWarnedModel: false,
    writes: Promise.resolve(),
  }

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    s.isModeOn = MODE_ON.test(await readOr($, SETTINGS, ''))
    refreshStatus($, s)
    return r
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const role: Role | undefined =
      e.subagentType === WORKER ? 'worker' : e.subagentType === QA ? 'qa' : e.subagentType === REVIEWER ? 'reviewer' : undefined
    if (!role) return next(e)
    const isReviewer = role === 'reviewer'

    const t = getTask(s, e.prompt)
    if (!t) return { deny: 'foreman-hud: brief ต้องมีบรรทัด "TASK: <id> — <ชื่อ>" เพื่อให้ติดตามงานได้' }
    if (t.isClosed) {
      return { deny: `foreman-hud: ${t.id} ปิดไปแล้ว (${RESULT_TH[t.result ?? ''] ?? t.result}) ถ้าจะทำใหม่ให้ใช้ task id ใหม่` }
    }

    if (!s.hasWarnedModel && tierOf(e.parentModel) !== 'opus') {
      s.hasWarnedModel = true
      $.ui.toast('foreman-hud: session หลักไม่ได้ใช้ Opus แนะนำให้พิมพ์ /model opus')
    }

    let tier: Tier
    let call = e
    if (isReviewer) {
      if (t.reviews >= MAX_REVIEWS) {
        await closeTask($, s, t, 'CAP')
        await logEvent($, s, { task: t.id, event: 'cap', reviews: t.reviews })
        refreshStatus($, s)
        return { deny: `foreman-hud: ${t.id} รีวิวครบ ${MAX_REVIEWS} ครั้งแล้ว ให้หยุดและรายงานผู้ใช้` }
      }
      const need = requiredReview(t)
      // ไม่ระบุ model = ปฏิเสธ (เดิมปล่อยให้ใช้ Opus จาก reviewer.md ทำให้ได้ Opus โดยไม่ตั้งใจ)
      const asked = tierOf(e.model)
      if (!asked) {
        return { deny: `foreman-hud: ต้องระบุ model ของ reviewer ตามช่อง "ระดับรีวิว" ใน brief (${t.id} ขั้นต่ำ ${label(need.tier)}: ${need.why})` }
      }
      if (LADDER.indexOf(asked) < LADDER.indexOf(need.tier)) {
        return { deny: `foreman-hud: ${t.id} ต้องใช้ reviewer ระดับ ${label(need.tier)} ขึ้นไป (${need.why})` }
      }
      tier = asked
      call = { ...e, model: asked }
    } else if (role === 'qa') {
      tier = 'sonnet'
      call = { ...e, model: 'sonnet' }
    } else {
      const asked = tierOf(e.model)
      if (!asked) return { deny: 'foreman-hud: ต้องระบุ model (haiku / sonnet / opus) ตอนเรียก worker ตามคะแนนใน rubric' }
      if (t.lastTier && LADDER.indexOf(asked) < LADDER.indexOf(t.lastTier)) {
        return { deny: `foreman-hud: ${t.id} เคยใช้ ${label(t.lastTier)} แล้ว ห้ามลดระดับเป็น ${label(asked)}` }
      }
      tier = asked
    }

    const r = await next(call)
    if (r.deny !== undefined || r.agentId === undefined) return r

    s.runs.set(r.agentId, { task: t.id, role, tier, isDone: false })
    if (isReviewer) {
      t.reviews += 1
      t.reviewTiers.push(tier)
      t.minNextReview = undefined
    }
    else if (role === 'qa') t.qaRuns += 1
    else {
      t.firstTier ??= tier
      t.lastTier = tier
    }
    await logEvent($, s, {
      task: t.id,
      event: 'spawn',
      role,
      model: r.model,
      effort: field(e.prompt, 'effort')?.split(/\s/)[0] ?? '-',
      ...(isReviewer ? { review: t.reviews, reviewer: tier } : {}),
    })
    refreshStatus($, s)
    return r
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) {
      // รอบของ session หลักจบ: เช็กใหม่ว่าเปิดหรือปิดโหมดไปหรือยัง (เช่นเพิ่งพิมพ์ /model-foreman:on)
      const isOn = MODE_ON.test(await readOr($, SETTINGS, ''))
      if (isOn !== s.isModeOn) {
        s.isModeOn = isOn
        refreshStatus($, s)
      }
      return r
    }
    const run = s.runs.get(e.agentId)
    if (!run || run.isDone) return r
    run.isDone = true

    const t = s.tasks.get(run.task)
    if (!t) return r
    const u = e.usage
    t.tokensIn += (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0)
    t.tokensOut += u?.output_tokens ?? 0

    if (run.role === 'worker') {
      const status = field(e.answer, 'สถานะ') ?? (e.isAborted ? 'ถูกหยุด' : '-')
      const tests = field(e.answer, 'ผล test')
      t.testsPassed = parseTestsPassed(tests)
      await logEvent($, s, { task: t.id, event: 'done', role: 'worker', tier: run.tier, status, testsPassed: t.testsPassed, usage: u })
    } else if (run.role === 'qa') {
      const status = field(e.answer, 'QA สถานะ') ?? (e.isAborted ? 'ถูกหยุด' : '-')
      t.qaStatus = status
      await logEvent($, s, { task: t.id, event: 'qa', status, usage: u })
      if (qaFoundIssue(status)) $.ui.toast(`${t.id} QA พบปัญหา ส่งต่อให้ reviewer`)
    } else {
      const m = e.answer.match(/VERDICT\s*:\s*(PASS|FIX|ESCALATE_REVIEW|ESCALATE|BLOCKED)/i)
      const verdict = m?.[1]?.toUpperCase() ?? 'UNKNOWN'
      t.result = verdict
      await logEvent($, s, { task: t.id, event: 'verdict', verdict, review: t.reviews, reviewer: run.tier, usage: u })
      if (verdict === 'PASS') {
        await closeTask($, s, t, 'PASS')
        $.ui.toast(`✓ ${t.id} ผ่านรีวิว (${label(t.lastTier)})`)
      } else if (verdict === 'BLOCKED') {
        await closeTask($, s, t, 'BLOCKED')
        $.ui.toast(`${t.id} ติด: spec ไม่ชัด รอคุณตอบ`)
      } else if (verdict === 'ESCALATE_REVIEW') {
        t.minNextReview = nextTier(run.tier)
        $.ui.toast(`${t.id} reviewer ${label(run.tier)} ไม่มั่นใจ ส่งต่อให้ ${label(t.minNextReview)}`)
      } else if (verdict === 'ESCALATE') {
        $.ui.toast(`${t.id} ไม่ผ่าน ต้องยกระดับจาก ${label(t.lastTier)}`)
      }
    }
    refreshStatus($, s)
    return r
  }).catch(($, e, next) => next(e))
}

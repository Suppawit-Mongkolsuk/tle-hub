import type { EngineInterface, Register } from 'claude-code'

// foreman-hud: mod ส่วนตัวสำหรับ model-foreman (ใช้คู่กับ model-foreman 0.6.0 ขึ้นไป)
// - บังคับกฎ: worker ต้องระบุโมเดล, ห้ามลดระดับ, FIX ได้ 1 ครั้งต่อโมเดล, ESCALATE ต้องยกระดับจริง,
//   reviewer อยู่ระหว่างขั้นต่ำตาม rubric กับเพดานใน brief, QA เป็น Sonnet เสมอ,
//   ทุก agent ต้องมี effort ใน brief, รีวิวไม่เกิน 5 ครั้งต่อ task,
//   รีวิวรวม (TASK: FINAL) ต้องเป็น Opus, worker ที่ไฟล์ซ้อนกับ worker ที่ยังทำอยู่ถูกปฏิเสธ
// - บันทึก log จากเหตุการณ์จริงลง .claude/foreman-log.jsonl และ .claude/router-log.md
// - เก็บ state ของ task ลง .claude/foreman/state.json ให้ทำงานต่อข้าม session ได้
// - แสดงสถานะใน status line และ toast

const WORKER = 'model-foreman:worker'
const REVIEWER = 'model-foreman:reviewer'
const QA = 'model-foreman:qa'
const LADDER = ['haiku', 'sonnet', 'opus'] as const
type Tier = (typeof LADDER)[number]
const MAX_REVIEWS = 5
const MAX_SAVED_TASKS = 300
const EFFORTS = ['low', 'medium', 'high'] as const

const JSONL = '.claude/foreman-log.jsonl'
const MD = '.claude/router-log.md'
const STATE = '.claude/foreman/state.json'
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

const WORKER_STATUSES = ['DONE_WITH_CONCERNS', 'DONE', 'NEEDS_CONTEXT', 'BLOCKED', 'DISPUTE'] as const

type Role = 'worker' | 'qa' | 'reviewer'

type Task = {
  key: string
  run: string
  isRunExplicit: boolean
  id: string
  title: string
  score: string
  skill: string
  files: string[]
  isHighRisk: boolean
  reviewCap?: Tier
  testsPassed?: boolean
  reviewTiers: Tier[]
  minNextReview?: Tier
  firstTier?: Tier
  lastTier?: Tier
  reviews: number
  qaRuns: number
  qaStatus?: string
  qaSeverity?: string
  needsFix: boolean
  fixUsed: Tier[]
  mustEscalateFrom?: Tier
  result?: string
  isClosed: boolean
  tokensIn: number
  tokensOut: number
}

type Run = { key: string; role: Role; tier: Tier; isDone: boolean }

const idx = (t: Tier) => LADDER.indexOf(t)

const tierOf = (model?: string): Tier | undefined => {
  const m = (model ?? '').toLowerCase()
  return LADDER.find(t => m.includes(t))
}

const label = (t?: Tier) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : '-')

const field = (text: string, name: string) => {
  const m = text.match(new RegExp(`^\\s*${name}\\s*:\\s*(.+)$`, 'm'))
  return m?.[1]?.trim()
}

const firstWord = (text?: string) => (text ?? '').trim().split(/[\s(]/)[0] ?? ''

const parseTask = (prompt: string) => {
  const m = prompt.match(/TASK\s*:\s*([A-Za-z0-9_.-]+)[ \t]*(?:[—–:-][ \t]*([^\n]*))?/)
  return m?.[1] ? { id: m[1], title: (m[2] ?? '').trim() } : undefined
}

// สถานะ QA: นับว่าพบปัญหาเฉพาะเมื่อขึ้นต้นด้วย "พบปัญหา"
// ("ไม่พบปัญหา" มีคำว่า "พบปัญหา" อยู่ข้างใน ห้ามใช้ includes)
const qaFoundIssue = (status?: string) => /^\s*พบปัญหา/.test(status ?? '')

// QA พบปัญหาที่ต้องแก้ก่อนรีวิว / ต้องใช้ Opus รีวิว: ระดับสูงหรือกลาง
// รายงานแบบเก่าที่ไม่มีบรรทัด "ระดับสูงสุด" ถือว่าร้ายแรงไว้ก่อน
const qaIsSerious = (status?: string, severity?: string) =>
  qaFoundIssue(status) && (severity === undefined || /^\s*(สูง|กลาง)/.test(severity))

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

const parseWorkerStatus = (status?: string) => {
  const word = firstWord(status).toUpperCase()
  return WORKER_STATUSES.find(s => word === s)
}

// ช่อง "ไฟล์:" ใน brief: เก็บเฉพาะคำที่หน้าตาเป็น path
const parseFiles = (text?: string) =>
  (text ?? '')
    .split(/[,\s]+/)
    .map(w => w.replace(/^[`'"(]+|[`'")]+$/g, '').replace(/^\.\//, ''))
    .filter(w => w.includes('/') || /\.[A-Za-z0-9]+$/.test(w))

const FINAL_ID = 'FINAL'

const nextTier = (t: Tier): Tier => LADDER[Math.min(idx(t) + 1, LADDER.length - 1)] ?? 'opus'

// ระดับ reviewer ขั้นต่ำตามตาราง "เลือกโมเดลของ reviewer" ใน rubric
const requiredReview = (t: Task): { tier: Tier; why: string } => {
  const score = Number.parseInt(t.score, 10)
  let need: { tier: Tier; why: string }
  if (t.id === FINAL_ID) need = { tier: 'opus', why: 'รีวิวรวมทั้งงาน' }
  else if (t.isHighRisk) need = { tier: 'opus', why: 'ความเสี่ยงสูง' }
  else if (Number.isFinite(score) && score >= 7) need = { tier: 'opus', why: `คะแนน ${score}` }
  else if (t.lastTier === 'opus') need = { tier: 'opus', why: 'worker เป็น Opus' }
  else if (qaIsSerious(t.qaStatus, t.qaSeverity)) need = { tier: 'opus', why: 'QA พบปัญหาระดับกลางขึ้นไป' }
  else if (Number.isFinite(score) && score <= 3 && t.testsPassed === true) need = { tier: 'haiku', why: `คะแนน ${score} และ test ผ่าน` }
  else need = { tier: 'sonnet', why: Number.isFinite(score) ? `คะแนน ${score}` : 'ไม่รู้คะแนน' }
  if (t.minNextReview && idx(t.minNextReview) > idx(need.tier)) {
    need = { tier: t.minNextReview, why: 'reviewer รอบก่อนส่งต่อ' }
  }
  return need
}

type State = {
  tasks: Map<string, Task>
  runs: Map<string, Run>
  sessionRun?: string
  activeRun?: string
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

function saveState($: EngineInterface, s: State) {
  return queue(s, async () => {
    const tasks = [...s.tasks.values()].slice(-MAX_SAVED_TASKS)
    await $.fs.write(STATE, JSON.stringify({ version: 1, tasks }, null, 1) + '\n')
  })
}

async function loadState($: EngineInterface, s: State) {
  try {
    const data = JSON.parse(await readOr($, STATE, '{}')) as { tasks?: Task[] }
    for (const t of data.tasks ?? []) {
      if (t && typeof t.key === 'string') {
        s.tasks.set(t.key, { ...t, files: t.files ?? [], fixUsed: t.fixUsed ?? [], reviewTiers: t.reviewTiers ?? [] })
      }
    }
  } catch {
    // state เสียหาย: เริ่มใหม่ ไม่ให้ hud ล้ม
  }
}

function logRow($: EngineInterface, s: State, t: Task) {
  return queue(s, async () => {
    const old = await readOr($, MD, '')
    const name = `${t.isRunExplicit ? `[${t.run}] ` : ''}${t.id} ${t.title}`.trim()
    const cells = [
      new Date().toISOString().slice(0, 10),
      name,
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
  const all = [...s.tasks.values()].filter(t => t.run === s.activeRun)
  const active = [...s.runs.values()].filter(r => !r.isDone)
  if (!s.isModeOn && all.length === 0) {
    $.ui.status(undefined)
    return
  }
  const parts = ['Foreman']
  for (const r of active) {
    const t = s.tasks.get(r.key)
    const what = r.role === 'reviewer' ? `รีวิว ${t?.reviews ?? 0}/${MAX_REVIEWS}` : r.role === 'qa' ? 'QA' : 'กำลังทำ'
    parts.push(`${t?.id ?? r.key} ${label(r.tier)} ${what}`)
  }
  parts.push(all.length > 0 ? `เสร็จ ${all.filter(t => t.isClosed).length}/${all.length}` : 'ON')
  $.ui.status(parts.join(' · '))
}

function currentRun(s: State, prompt: string) {
  const explicit = field(prompt, 'RUN')?.split(/\s/)[0]
  if (explicit) return { run: explicit, isExplicit: true }
  // ไม่มี RUN ใน brief: ใช้ run ของ session นี้ (task id ซ้ำข้าม session ได้)
  s.sessionRun ??= `S-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`
  return { run: s.sessionRun, isExplicit: false }
}

function getTask(s: State, prompt: string) {
  const parsed = parseTask(prompt)
  if (!parsed) return undefined
  const { run, isExplicit } = currentRun(s, prompt)
  const key = `${run}/${parsed.id}`
  const known = s.tasks.get(key)
  if (known) return known
  const t: Task = {
    key,
    run,
    isRunExplicit: isExplicit,
    id: parsed.id,
    title: parsed.title,
    score: field(prompt, 'คะแนน') ?? '-',
    skill: field(prompt, 'SKILL ที่ต้องโหลดก่อนเริ่ม') ?? '-',
    files: [],
    isHighRisk: /^ใช่/.test(field(prompt, 'ความเสี่ยงสูง') ?? ''),
    reviewCap: tierOf(firstWord(field(prompt, 'ระดับรีวิว'))),
    reviewTiers: [],
    reviews: 0,
    qaRuns: 0,
    needsFix: false,
    fixUsed: [],
    isClosed: false,
    tokensIn: 0,
    tokensOut: 0,
  }
  s.tasks.set(key, t)
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
    await loadState($, s)
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

    const effort = firstWord(field(e.prompt, 'effort')).toLowerCase()
    if (!EFFORTS.includes(effort as (typeof EFFORTS)[number])) {
      return { deny: `foreman-hud: brief ของ ${t.id} ต้องมีบรรทัด "effort: low / medium / high" ตาม rubric (ห้าม max)` }
    }

    if (!s.hasWarnedModel && tierOf(e.parentModel) !== 'opus') {
      s.hasWarnedModel = true
      $.ui.toast('foreman-hud: session หลักไม่ได้ใช้ Opus แนะนำให้พิมพ์ /model opus')
    }

    // ระดับรีวิวในบรรทัดของ reviewer brief ใช้แทนค่าเดิมได้ (เช่นผู้จัดการแก้ brief)
    const capInPrompt = tierOf(firstWord(field(e.prompt, 'ระดับรีวิว')))
    if (capInPrompt) t.reviewCap = capInPrompt

    let tier: Tier
    let call = e
    let isFixRetry = false
    if (isReviewer) {
      if (t.reviews >= MAX_REVIEWS) {
        await closeTask($, s, t, 'CAP')
        await logEvent($, s, { run: t.run, task: t.id, event: 'cap', reviews: t.reviews })
        await saveState($, s)
        refreshStatus($, s)
        return { deny: `foreman-hud: ${t.id} รีวิวครบ ${MAX_REVIEWS} ครั้งแล้ว ให้หยุดและรายงานผู้ใช้` }
      }
      const need = requiredReview(t)
      // ไม่ระบุ model = ปฏิเสธ (เดิมปล่อยให้ใช้ Opus จาก reviewer.md ทำให้ได้ Opus โดยไม่ตั้งใจ)
      const asked = tierOf(e.model)
      if (!asked) {
        return { deny: `foreman-hud: ต้องระบุ model ของ reviewer ตามช่อง "ระดับรีวิว" ใน brief (${t.id} ขั้นต่ำ ${label(need.tier)}: ${need.why})` }
      }
      if (idx(asked) < idx(need.tier)) {
        return { deny: `foreman-hud: ${t.id} ต้องใช้ reviewer ระดับ ${label(need.tier)} ขึ้นไป (${need.why})` }
      }
      // เพดาน: ระดับรีวิวใน brief (ยกเว้นขั้นต่ำที่สูงกว่า เช่น ESCALATE_REVIEW หรือ QA เจอปัญหา)
      const ceiling = t.reviewCap && idx(t.reviewCap) > idx(need.tier) ? t.reviewCap : (t.reviewCap ? need.tier : undefined)
      if (ceiling && idx(asked) > idx(ceiling)) {
        return { deny: `foreman-hud: ${t.id} ใช้ reviewer ได้สูงสุด ${label(ceiling)} ตามช่อง "ระดับรีวิว" ใน brief ถ้าคิดว่าเสี่ยงกว่านั้น ให้แก้คะแนนความเสี่ยงใน brief` }
      }
      tier = asked
      call = { ...e, model: asked }
    } else if (role === 'qa') {
      tier = 'sonnet'
      call = { ...e, model: 'sonnet' }
    } else {
      const asked = tierOf(e.model)
      if (!asked) return { deny: 'foreman-hud: ต้องระบุ model (haiku / sonnet / opus) ตอนเรียก worker ตามคะแนนใน rubric' }
      if (t.lastTier && idx(asked) < idx(t.lastTier)) {
        return { deny: `foreman-hud: ${t.id} เคยใช้ ${label(t.lastTier)} แล้ว ห้ามลดระดับเป็น ${label(asked)}` }
      }
      if (t.mustEscalateFrom && idx(asked) <= idx(t.mustEscalateFrom)) {
        return {
          deny:
            t.mustEscalateFrom === 'opus'
              ? `foreman-hud: ${t.id} Opus ได้ ESCALATE ไม่มีโมเดลให้ยกระดับต่อ ให้หยุดและรายงานผู้ใช้`
              : `foreman-hud: ${t.id} ได้ ESCALATE จาก ${label(t.mustEscalateFrom)} ต้องส่งให้ ${label(nextTier(t.mustEscalateFrom))} ขึ้นไป`,
        }
      }
      const files = parseFiles(field(e.prompt, 'ไฟล์'))
      if (files.length > 0) t.files = files
      for (const other of s.runs.values()) {
        if (other.isDone || other.role !== 'worker' || other.key === t.key) continue
        const o = s.tasks.get(other.key)
        const clash = o?.files.filter(f => t.files.includes(f)) ?? []
        if (o && clash.length > 0) {
          return { deny: `foreman-hud: ${t.id} แก้ไฟล์ซ้อนกับ ${o.id} ที่ยังทำอยู่ (${clash.join(', ')}) ให้รอ ${o.id} เสร็จก่อน` }
        }
      }
      if (t.needsFix && asked === t.lastTier) {
        if (t.fixUsed.includes(asked)) {
          return {
            deny:
              asked === 'opus'
                ? `foreman-hud: ${t.id} Opus ใช้สิทธิ์ FIX ไปแล้วและยังไม่ผ่าน ให้หยุดและรายงานผู้ใช้`
                : `foreman-hud: ${t.id} ${label(asked)} ใช้สิทธิ์ FIX ไปแล้ว ต้องยกระดับเป็น ${label(nextTier(asked))}`,
          }
        }
        isFixRetry = true
      }
      tier = asked
    }

    const r = await next(call)
    if (r.deny !== undefined || r.agentId === undefined) return r

    s.activeRun = t.run
    s.runs.set(r.agentId, { key: t.key, role, tier, isDone: false })
    if (isReviewer) {
      t.reviews += 1
      t.reviewTiers.push(tier)
      t.minNextReview = undefined
    } else if (role === 'qa') t.qaRuns += 1
    else {
      if (isFixRetry) t.fixUsed.push(tier)
      t.needsFix = false
      t.mustEscalateFrom = undefined
      t.firstTier ??= tier
      t.lastTier = tier
    }
    await logEvent($, s, {
      run: t.run,
      task: t.id,
      event: 'spawn',
      role,
      model: r.model,
      effort,
      ...(role === 'worker'
        ? {
            score: t.score,
            highRisk: t.isHighRisk,
            qa: firstWord(field(e.prompt, 'QA')) || '-',
            reviewLevel: t.reviewCap ?? '-',
            skill: t.skill,
            files: t.files,
            fixRetry: isFixRetry,
          }
        : {}),
      ...(isReviewer ? { review: t.reviews, reviewer: tier } : {}),
    })
    await saveState($, s)
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

    const t = s.tasks.get(run.key)
    if (!t) return r
    const u = e.usage
    t.tokensIn += (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0)
    t.tokensOut += u?.output_tokens ?? 0

    if (run.role === 'worker') {
      const status = field(e.answer, 'สถานะ') ?? (e.isAborted ? 'ถูกหยุด' : '-')
      const code = parseWorkerStatus(status)
      t.testsPassed = parseTestsPassed(field(e.answer, 'ผล test'))
      await logEvent($, s, {
        run: t.run, task: t.id, event: 'done', role: 'worker', tier: run.tier,
        status, code: code ?? '-', testsPassed: t.testsPassed ?? null, patch: field(e.answer, 'patch')?.split(/\s/)[0] ?? '-', usage: u,
      })
      if (code === 'NEEDS_CONTEXT') $.ui.toast(`${t.id} ต้องการข้อมูลเพิ่มก่อนเริ่ม`)
      else if (code === 'BLOCKED') $.ui.toast(`${t.id} ติด: worker ทำต่อไม่ได้`)
      else if (code === 'DISPUTE') $.ui.toast(`${t.id} worker แย้ง feedback ส่งให้ reviewer ตัดสิน`)
    } else if (run.role === 'qa') {
      const status = field(e.answer, 'QA สถานะ') ?? (e.isAborted ? 'ถูกหยุด' : '-')
      const severity = field(e.answer, 'ระดับสูงสุด')
      t.qaStatus = status
      t.qaSeverity = severity
      if (qaIsSerious(status, severity)) t.needsFix = true
      await logEvent($, s, { run: t.run, task: t.id, event: 'qa', status, severity: severity ?? '-', usage: u })
      if (qaFoundIssue(status)) $.ui.toast(`${t.id} QA พบปัญหา${severity ? `ระดับ${firstWord(severity)}` : ''}`)
    } else {
      const m = e.answer.match(/VERDICT\s*:\s*(PASS|FIX|ESCALATE_REVIEW|ESCALATE|BLOCKED)/i)
      const verdict = m?.[1]?.toUpperCase() ?? 'UNKNOWN'
      t.result = verdict
      await logEvent($, s, { run: t.run, task: t.id, event: 'verdict', verdict, review: t.reviews, reviewer: run.tier, usage: u })
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
        t.mustEscalateFrom = t.lastTier
        t.needsFix = false
        $.ui.toast(`${t.id} ไม่ผ่าน ต้องยกระดับจาก ${label(t.lastTier)}`)
      } else if (verdict === 'FIX') {
        t.needsFix = true
      }
    }
    await saveState($, s)
    refreshStatus($, s)
    return r
  }).catch(($, e, next) => next(e))
}

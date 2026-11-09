import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

type Env = {
  files: Map<string, string>
  statuses: (string | undefined)[]
  toasts: string[]
  spawned: { subagentType?: string; model?: string }[]
}

// hooks ที่อยู่ใต้ plugin แทน engine: ไฟล์ในหน่วยความจำ, จับ status/toast, จำลองการสร้าง subagent
function setup(on: On, settings?: string): Env {
  const env: Env = { files: new Map(), statuses: [], toasts: [], spawned: [] }
  if (settings !== undefined) env.files.set('.claude/settings.local.json', settings)
  let n = 0
  const key = (path: string) => path.replace(/^.*?(\.claude\/)/, '$1')
  on('fs.read', ($, e) => {
    const text = env.files.get(key(e.path))
    return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
  })
  on('fs.write', ($, e) => {
    env.files.set(key(e.path), e.text)
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    env.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    env.toasts.push(e.text)
    return { value: undefined }
  })
  on('agent.spawn', ($, e) => {
    env.spawned.push({ subagentType: e.subagentType, model: e.model })
    n += 1
    return { model: e.model ?? 'inherit', agentId: `agent-${n}` }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  return env
}

const brief = (id: string, extra = '') =>
  `TASK: ${id} — ปุ่ม settings\nคะแนน: 2\nSKILL ที่ต้องโหลดก่อนเริ่ม: ui-guidelines\n${extra}\neffort: medium`

const usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20, cache_creation_input_tokens: 0, model: 'x' }

function spawnInput(prompt: string, subagentType: string, model?: string) {
  return {
    tool_use_id: `tool-${Math.random()}`,
    prompt,
    description: 'task',
    subagentType,
    provider: { plugin: 'engine', tier: 'core' as const },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
    ...(model ? { model } : {}),
  }
}

async function spawn($: Engine, type: 'worker' | 'qa' | 'reviewer', id: string, model?: string, extra = '') {
  return $.agent.spawn(spawnInput(brief(id, extra), `model-foreman:${type}`, model))
}

async function finish($: Engine, agentId: string, answer: string) {
  return $.turn.complete({
    answer,
    agentId,
    durationMs: 1000,
    isAborted: false,
    turnId: `turn-${agentId}`,
    reason: 'answer',
    usage,
  })
}

describe('กฎการเลือกโมเดล', () => {
  test('worker ที่ไม่ระบุ model ถูกปฏิเสธ', async ($, on) => {
    const env = setup(on)
    const r = await spawn($, 'worker', 'T1')
    expect(r.deny).toContain('ต้องระบุ model')
    expect(env.spawned.length).toBe(0)
  })

  test('brief ที่ไม่มี TASK ถูกปฏิเสธ', async ($, on) => {
    setup(on)
    const r = await $.agent.spawn(spawnInput('แก้ปุ่ม', 'model-foreman:worker', 'haiku'))
    expect(r.deny).toContain('TASK')
  })

  test('agent อื่นที่ไม่ใช่ของ model-foreman ผ่านไปตามปกติ', async ($, on) => {
    const env = setup(on)
    const r = await $.agent.spawn(spawnInput('ค้นไฟล์', 'Explore'))
    expect(r.deny).toBeUndefined()
    expect(env.spawned[0]?.subagentType).toBe('Explore')
  })

  test('ห้ามลดระดับโมเดลของ task เดิม แต่ใช้ระดับเดิมซ้ำได้', async ($, on) => {
    setup(on)
    const first = await spawn($, 'worker', 'T1', 'sonnet')
    expect(first.deny).toBeUndefined()
    const same = await spawn($, 'worker', 'T1', 'sonnet')
    expect(same.deny).toBeUndefined()
    const down = await spawn($, 'worker', 'T1', 'haiku')
    expect(down.deny).toContain('ห้ามลดระดับ')
    const up = await spawn($, 'worker', 'T1', 'opus')
    expect(up.deny).toBeUndefined()
  })

  test('รีวิวครั้งที่ 6 ถูกปฏิเสธและปิด task', async ($, on) => {
    const env = setup(on)
    for (let i = 0; i < 5; i++) {
      const r = await spawn($, 'reviewer', 'T1', 'opus')
      expect(r.deny).toBeUndefined()
      await finish($, r.agentId!, 'VERDICT: FIX')
    }
    const sixth = await spawn($, 'reviewer', 'T1', 'opus')
    expect(sixth.deny).toContain('รีวิวครบ 5 ครั้ง')
    expect(env.files.get('.claude/router-log.md')).toContain('ชนเพดานรีวิว')
  })
})

describe('ระดับ reviewer ตาม rubric', () => {
  test('คะแนน 0–3 และ test ผ่าน: Haiku รีวิวได้', async ($, on) => {
    const env = setup(on)
    const w = await spawn($, 'worker', 'T1', 'haiku')
    await finish($, w.agentId!, 'สถานะ: เสร็จ\nผล test: npm test ผ่าน')
    const r = await spawn($, 'reviewer', 'T1', 'haiku')
    expect(r.deny).toBeUndefined()
    expect(env.spawned.at(-1)?.model).toBe('haiku')
  })

  test('คะแนน 0–3 แต่ test ไม่ผ่าน: ต้อง Sonnet ขึ้นไป', async ($, on) => {
    setup(on)
    const w = await spawn($, 'worker', 'T1', 'haiku')
    await finish($, w.agentId!, 'สถานะ: ไม่เสร็จ\nผล test: npm test ไม่ผ่าน')
    const haiku = await spawn($, 'reviewer', 'T1', 'haiku')
    expect(haiku.deny).toContain('ระดับ Sonnet ขึ้นไป')
    const sonnet = await spawn($, 'reviewer', 'T1', 'sonnet')
    expect(sonnet.deny).toBeUndefined()
  })

  test('ผล test "12 passed, 0 failed" นับว่าผ่าน: Haiku รีวิวได้', async ($, on) => {
    setup(on)
    const w = await spawn($, 'worker', 'T1', 'haiku')
    await finish($, w.agentId!, 'สถานะ: เสร็จ\nผล test: npx vitest run — 12 passed, 0 failed')
    const r = await spawn($, 'reviewer', 'T1', 'haiku')
    expect(r.deny).toBeUndefined()
  })

  test('ผล test "3 failed" หรือ "ไม่ผ่าน-มีอยู่เดิม" นับว่าไม่ผ่าน', async ($, on) => {
    setup(on)
    const w1 = await spawn($, 'worker', 'T1', 'haiku')
    await finish($, w1.agentId!, 'สถานะ: เสร็จ\nผล test: 9 passed, 3 failed')
    expect((await spawn($, 'reviewer', 'T1', 'haiku')).deny).toContain('ระดับ Sonnet ขึ้นไป')
    const w2 = await spawn($, 'worker', 'T4', 'haiku')
    await finish($, w2.agentId!, 'สถานะ: เสร็จ\nผล test: ไม่ผ่าน-มีอยู่เดิม')
    expect((await spawn($, 'reviewer', 'T4', 'haiku')).deny).toContain('ระดับ Sonnet ขึ้นไป')
  })

  test('ไม่มีบรรทัดผล test: ต้อง Sonnet ขึ้นไป', async ($, on) => {
    setup(on)
    const w = await spawn($, 'worker', 'T1', 'haiku')
    await finish($, w.agentId!, 'สถานะ: เสร็จ')
    expect((await spawn($, 'reviewer', 'T1', 'haiku')).deny).toContain('ระดับ Sonnet ขึ้นไป')
  })

  test('ความเสี่ยงสูง: ต้อง Opus แม้คะแนนต่ำ', async ($, on) => {
    setup(on)
    const w = await spawn($, 'worker', 'T9', 'haiku', 'ความเสี่ยงสูง: ใช่')
    await finish($, w.agentId!, 'สถานะ: เสร็จ\nผล test: ผ่าน')
    const sonnet = await spawn($, 'reviewer', 'T9', 'sonnet')
    expect(sonnet.deny).toContain('ระดับ Opus ขึ้นไป (ความเสี่ยงสูง)')
  })

  test('QA พบปัญหา: ต้อง Opus', async ($, on) => {
    setup(on)
    const w = await spawn($, 'worker', 'T2', 'haiku')
    await finish($, w.agentId!, 'สถานะ: เสร็จ\nผล test: ผ่าน')
    const q = await spawn($, 'qa', 'T2')
    await finish($, q.agentId!, 'QA สถานะ: พบปัญหา')
    const haiku = await spawn($, 'reviewer', 'T2', 'haiku')
    expect(haiku.deny).toContain('QA พบปัญหา')
  })

  test('ไม่ระบุ model ของ reviewer ถูกปฏิเสธ (ไม่ใช้ Opus ให้เงียบ ๆ)', async ($, on) => {
    const env = setup(on)
    const w = await spawn($, 'worker', 'T1', 'haiku')
    await finish($, w.agentId!, 'สถานะ: เสร็จ\nผล test: ผ่าน')
    const r = await spawn($, 'reviewer', 'T1')
    expect(r.deny).toContain('ต้องระบุ model ของ reviewer')
    expect(r.deny).toContain('ขั้นต่ำ Haiku')
    expect(env.spawned.length).toBe(1)
  })

  test('QA ไม่พบปัญหา: ไม่บังคับ Opus และไม่เด้ง toast', async ($, on) => {
    const env = setup(on)
    const w = await spawn($, 'worker', 'T2', 'haiku')
    await finish($, w.agentId!, 'สถานะ: เสร็จ\nผล test: ผ่าน')
    const q = await spawn($, 'qa', 'T2')
    await finish($, q.agentId!, 'QA สถานะ: ไม่พบปัญหา (มีข้อสังเกต 2 ข้อ ไม่ใช่บั๊ก)')
    expect(env.toasts.some(t => t.includes('QA พบปัญหา'))).toBe(false)
    const haiku = await spawn($, 'reviewer', 'T2', 'haiku')
    expect(haiku.deny).toBeUndefined()
  })

  test('QA พบปัญหา แล้วแก้จน QA รอบใหม่ไม่พบปัญหา: กลับมาใช้ระดับตาม rubric', async ($, on) => {
    setup(on)
    const w1 = await spawn($, 'worker', 'T2', 'haiku')
    await finish($, w1.agentId!, 'สถานะ: เสร็จ\nผล test: ผ่าน')
    const q1 = await spawn($, 'qa', 'T2')
    await finish($, q1.agentId!, 'QA สถานะ: พบปัญหา (เล็กน้อย 1 ข้อ)')
    const w2 = await spawn($, 'worker', 'T2', 'haiku')
    await finish($, w2.agentId!, 'สถานะ: เสร็จ\nผล test: ผ่าน')
    const beforeQa = await spawn($, 'reviewer', 'T2', 'haiku')
    expect(beforeQa.deny).toContain('QA พบปัญหา')
    const q2 = await spawn($, 'qa', 'T2')
    await finish($, q2.agentId!, 'QA สถานะ: ไม่พบปัญหา')
    const haiku = await spawn($, 'reviewer', 'T2', 'haiku')
    expect(haiku.deny).toBeUndefined()
  })

  test('ESCALATE_REVIEW จาก Haiku: รอบถัดไปต้อง Sonnet ขึ้นไป', async ($, on) => {
    const env = setup(on)
    const w = await spawn($, 'worker', 'T1', 'haiku')
    await finish($, w.agentId!, 'สถานะ: เสร็จ\nผล test: ผ่าน')
    const r1 = await spawn($, 'reviewer', 'T1', 'haiku')
    await finish($, r1.agentId!, 'VERDICT: ESCALATE_REVIEW')
    expect(env.toasts.at(-1)).toContain('ส่งต่อให้ Sonnet')
    const again = await spawn($, 'reviewer', 'T1', 'haiku')
    expect(again.deny).toContain('reviewer รอบก่อนส่งต่อ')
    const r2 = await spawn($, 'reviewer', 'T1', 'sonnet')
    await finish($, r2.agentId!, 'VERDICT: PASS')
    expect(env.files.get('.claude/router-log.md')).toContain('| 2 (Haiku→Sonnet) | Haiku | ผ่าน |')
  })
})

describe('effort', () => {
  test('บันทึก effort จาก brief ลง log ตอนสร้าง agent', async ($, on) => {
    const env = setup(on)
    await spawn($, 'worker', 'T1', 'sonnet', 'effort: high   (ของ agent ที่รับ brief นี้)')
    const first = JSON.parse((env.files.get('.claude/foreman-log.jsonl') ?? '').trim().split('\n')[0]!)
    expect(first).toMatchObject({ task: 'T1', event: 'spawn', role: 'worker', effort: 'high' })
  })
})

describe('QA', () => {
  test('QA ถูกบังคับเป็น Sonnet แสดงใน status และบันทึกผลลง log', async ($, on) => {
    const env = setup(on)
    const w = await spawn($, 'worker', 'T2', 'haiku')
    await finish($, w.agentId!, 'สถานะ: เสร็จ')

    const q = await spawn($, 'qa', 'T2', 'haiku')
    expect(env.spawned.at(-1)?.model).toBe('sonnet')
    expect(env.statuses.at(-1)).toContain('T2 Sonnet QA')
    await finish($, q.agentId!, 'TASK: T2\nQA สถานะ: พบปัญหา\nปัญหาที่พบ: ค่าว่างทำให้ 500')
    expect(env.toasts.at(-1)).toBe('T2 QA พบปัญหา')

    const r = await spawn($, 'reviewer', 'T2', 'opus')
    await finish($, r.agentId!, 'VERDICT: PASS')
    expect(env.files.get('.claude/router-log.md')).toContain('| ui-guidelines | พบปัญหา (1) | 1 (Opus) |')
    const lines = (env.files.get('.claude/foreman-log.jsonl') ?? '').trim().split('\n')
    expect(lines.some(l => JSON.parse(l).event === 'qa')).toBe(true)
  })
})

describe('log และสถานะ', () => {
  test('flow เต็ม: Haiku ไม่ผ่าน ยกระดับเป็น Sonnet แล้วผ่าน', async ($, on) => {
    const env = setup(on)

    const w1 = await spawn($, 'worker', 'T3', 'haiku')
    expect(env.statuses.at(-1)).toContain('T3 Haiku กำลังทำ')
    await finish($, w1.agentId!, 'TASK: T3\nสถานะ: เสร็จ')

    const r1 = await spawn($, 'reviewer', 'T3', 'opus')
    expect(env.statuses.at(-1)).toContain('รีวิว 1/5')
    await finish($, r1.agentId!, 'TASK: T3\nVERDICT: ESCALATE')
    expect(env.toasts.at(-1)).toContain('ยกระดับจาก Haiku')

    const w2 = await spawn($, 'worker', 'T3', 'sonnet')
    await finish($, w2.agentId!, 'สถานะ: เสร็จ')
    const r2 = await spawn($, 'reviewer', 'T3', 'opus')
    await finish($, r2.agentId!, 'VERDICT: PASS')

    expect(env.toasts.at(-1)).toBe('✓ T3 ผ่านรีวิว (Sonnet)')
    expect(env.statuses.at(-1)).toBe('Foreman · เสร็จ 1/1')

    const md = env.files.get('.claude/router-log.md') ?? ''
    expect(md).toContain('| วันที่ | task |')
    // คะแนน 2, เริ่ม Haiku, skill ui-guidelines, รีวิว 2 ครั้ง, จบที่ Sonnet, ผ่าน, token 4 รอบ x (120 in / 50 out)
    expect(md).toContain('| T3 ปุ่ม settings | 2 | Haiku | ui-guidelines | - | 2 (Opus→Opus) | Sonnet | ผ่าน | 480/200 |')

    const lines = (env.files.get('.claude/foreman-log.jsonl') ?? '').trim().split('\n')
    expect(lines.length).toBe(8)
    expect(JSON.parse(lines[3]!)).toMatchObject({ task: 'T3', event: 'verdict', verdict: 'ESCALATE' })
  })

  test('task ที่ผ่านแล้วเรียก worker ซ้ำไม่ได้', async ($, on) => {
    setup(on)
    const r = await spawn($, 'reviewer', 'T1', 'opus')
    await finish($, r.agentId!, 'VERDICT: PASS')
    const again = await spawn($, 'worker', 'T1', 'opus')
    expect(again.deny).toContain('ปิดไปแล้ว')
  })

  test('เปิดโหมดอยู่: status line ขึ้น Foreman · ON ตอนเริ่ม session', async ($, on) => {
    const env = setup(on, '{"outputStyle":"model-foreman:Foreman"}')
    await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
    expect(env.statuses.at(-1)).toBe('Foreman · ON')
  })

  test('เปิดโหมดกลาง session: status line ขึ้นทันทีหลังรอบถัดไปจบ และหายเมื่อปิด', async ($, on) => {
    const env = setup(on, '{}')
    await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
    expect(env.statuses.at(-1)).toBeUndefined()
    env.files.set('.claude/settings.local.json', '{"outputStyle":"model-foreman:Foreman"}')
    await $.turn.complete({ answer: 'เปิดโหมดแล้ว', durationMs: 10, isAborted: false, turnId: 'm1', reason: 'answer' })
    expect(env.statuses.at(-1)).toBe('Foreman · ON')
    env.files.set('.claude/settings.local.json', '{}')
    await $.turn.complete({ answer: 'ปิดโหมดแล้ว', durationMs: 10, isAborted: false, turnId: 'm2', reason: 'answer' })
    expect(env.statuses.at(-1)).toBeUndefined()
  })

  test('ไม่ได้เปิดโหมดและไม่มีงาน: ไม่แสดงอะไร', async ($, on) => {
    const env = setup(on, '{}')
    await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
    expect(env.statuses.at(-1)).toBeUndefined()
  })
})

describe('0.5: effort และเพดาน reviewer', () => {
  test('brief ไม่มี effort หรือใช้ max ถูกปฏิเสธ', async ($, on) => {
    setup(on)
    const none = await $.agent.spawn(spawnInput('TASK: T1 — x\nคะแนน: 2', 'model-foreman:worker', 'haiku'))
    expect(none.deny).toContain('effort')
    const max = await $.agent.spawn(spawnInput('TASK: T1 — x\neffort: max', 'model-foreman:worker', 'haiku'))
    expect(max.deny).toContain('ห้าม max')
  })

  test('ระดับรีวิวใน brief เป็นเพดาน: brief บอก Sonnet ห้ามเรียก Opus', async ($, on) => {
    setup(on)
    const w = await spawn($, 'worker', 'T1', 'haiku', 'ระดับรีวิว: sonnet')
    await finish($, w.agentId!, 'สถานะ: DONE\nผล test: ผ่าน')
    const opus = await spawn($, 'reviewer', 'T1', 'opus', 'ระดับรีวิว: sonnet')
    expect(opus.deny).toContain('สูงสุด Sonnet')
    const sonnet = await spawn($, 'reviewer', 'T1', 'sonnet', 'ระดับรีวิว: sonnet')
    expect(sonnet.deny).toBeUndefined()
  })

  test('ESCALATE_REVIEW ยกเพดานตาม: brief บอก Haiku แต่รอบสองใช้ Sonnet ได้ ส่วน Opus ยังไม่ได้', async ($, on) => {
    setup(on)
    const w = await spawn($, 'worker', 'T1', 'haiku', 'ระดับรีวิว: haiku')
    await finish($, w.agentId!, 'สถานะ: DONE\nผล test: ผ่าน')
    const r1 = await spawn($, 'reviewer', 'T1', 'haiku', 'ระดับรีวิว: haiku')
    await finish($, r1.agentId!, 'VERDICT: ESCALATE_REVIEW')
    expect((await spawn($, 'reviewer', 'T1', 'opus', 'ระดับรีวิว: haiku')).deny).toContain('สูงสุด Sonnet')
    expect((await spawn($, 'reviewer', 'T1', 'sonnet', 'ระดับรีวิว: haiku')).deny).toBeUndefined()
  })

  test('QA พบปัญหาระดับกลาง: ต้อง Opus แม้ brief บอก Sonnet', async ($, on) => {
    setup(on)
    const w = await spawn($, 'worker', 'T2', 'sonnet', 'ระดับรีวิว: sonnet')
    await finish($, w.agentId!, 'สถานะ: DONE\nผล test: ผ่าน')
    const q = await spawn($, 'qa', 'T2', undefined, 'ระดับรีวิว: sonnet')
    await finish($, q.agentId!, 'QA สถานะ: พบปัญหา\nระดับสูงสุด: กลาง')
    expect((await spawn($, 'reviewer', 'T2', 'sonnet', 'ระดับรีวิว: sonnet')).deny).toContain('QA พบปัญหาระดับกลางขึ้นไป')
    expect((await spawn($, 'reviewer', 'T2', 'opus', 'ระดับรีวิว: sonnet')).deny).toBeUndefined()
  })

  test('QA พบปัญหาระดับต่ำ: ไม่บังคับ Opus', async ($, on) => {
    setup(on)
    const w = await spawn($, 'worker', 'T2', 'haiku')
    await finish($, w.agentId!, 'สถานะ: DONE\nผล test: ผ่าน')
    const q = await spawn($, 'qa', 'T2')
    await finish($, q.agentId!, 'QA สถานะ: พบปัญหา\nระดับสูงสุด: ต่ำ')
    expect((await spawn($, 'reviewer', 'T2', 'haiku')).deny).toBeUndefined()
  })
})

describe('0.5: สิทธิ์ FIX และการยกระดับ', () => {
  test('FIX ได้ 1 ครั้งต่อโมเดล ครั้งที่สองต้องยกระดับ', async ($, on) => {
    setup(on)
    const w1 = await spawn($, 'worker', 'T1', 'haiku')
    await finish($, w1.agentId!, 'สถานะ: DONE\nผล test: ผ่าน')
    const r1 = await spawn($, 'reviewer', 'T1', 'sonnet')
    await finish($, r1.agentId!, 'VERDICT: FIX')
    const w2 = await spawn($, 'worker', 'T1', 'haiku')
    expect(w2.deny).toBeUndefined()
    await finish($, w2.agentId!, 'สถานะ: DONE\nผล test: ผ่าน')
    const r2 = await spawn($, 'reviewer', 'T1', 'sonnet')
    await finish($, r2.agentId!, 'VERDICT: FIX')
    expect((await spawn($, 'worker', 'T1', 'haiku')).deny).toContain('ใช้สิทธิ์ FIX ไปแล้ว ต้องยกระดับเป็น Sonnet')
    expect((await spawn($, 'worker', 'T1', 'sonnet')).deny).toBeUndefined()
  })

  test('แก้ตาม QA นับเป็นการใช้สิทธิ์ FIX', async ($, on) => {
    setup(on)
    const w1 = await spawn($, 'worker', 'T1', 'haiku')
    await finish($, w1.agentId!, 'สถานะ: DONE\nผล test: ผ่าน')
    const q = await spawn($, 'qa', 'T1')
    await finish($, q.agentId!, 'QA สถานะ: พบปัญหา\nระดับสูงสุด: สูง')
    const w2 = await spawn($, 'worker', 'T1', 'haiku')
    expect(w2.deny).toBeUndefined()
    await finish($, w2.agentId!, 'สถานะ: DONE\nผล test: ผ่าน')
    const r = await spawn($, 'reviewer', 'T1', 'opus')
    await finish($, r.agentId!, 'VERDICT: FIX')
    expect((await spawn($, 'worker', 'T1', 'haiku')).deny).toContain('ใช้สิทธิ์ FIX ไปแล้ว')
  })

  test('NEEDS_CONTEXT ไม่นับเป็นการใช้สิทธิ์ FIX', async ($, on) => {
    const env = setup(on)
    const w1 = await spawn($, 'worker', 'T1', 'haiku')
    await finish($, w1.agentId!, 'สถานะ: NEEDS_CONTEXT\nคำถาม: ไฟล์ไหน')
    expect(env.toasts.at(-1)).toContain('ต้องการข้อมูลเพิ่ม')
    const w2 = await spawn($, 'worker', 'T1', 'haiku')
    await finish($, w2.agentId!, 'สถานะ: DONE\nผล test: ผ่าน')
    const r = await spawn($, 'reviewer', 'T1', 'sonnet')
    await finish($, r.agentId!, 'VERDICT: FIX')
    expect((await spawn($, 'worker', 'T1', 'haiku')).deny).toBeUndefined()
  })

  test('ESCALATE ต้องยกระดับจริง และ Opus ได้ ESCALATE ต้องหยุด', async ($, on) => {
    setup(on)
    const w1 = await spawn($, 'worker', 'T1', 'sonnet')
    await finish($, w1.agentId!, 'สถานะ: DONE')
    const r1 = await spawn($, 'reviewer', 'T1', 'sonnet')
    await finish($, r1.agentId!, 'VERDICT: ESCALATE')
    expect((await spawn($, 'worker', 'T1', 'sonnet')).deny).toContain('ต้องส่งให้ Opus')
    const w2 = await spawn($, 'worker', 'T1', 'opus')
    await finish($, w2.agentId!, 'สถานะ: DONE')
    const r2 = await spawn($, 'reviewer', 'T1', 'opus')
    await finish($, r2.agentId!, 'VERDICT: ESCALATE')
    expect((await spawn($, 'worker', 'T1', 'opus')).deny).toContain('หยุดและรายงานผู้ใช้')
  })
})

describe('0.5: run id, state และ log', () => {
  test('task id เดิมใช้ได้ใน run ใหม่', async ($, on) => {
    setup(on)
    const r = await spawn($, 'reviewer', 'T1', 'sonnet', 'RUN: R-a')
    await finish($, r.agentId!, 'VERDICT: PASS')
    expect((await spawn($, 'worker', 'T1', 'haiku', 'RUN: R-a')).deny).toContain('ปิดไปแล้ว')
    expect((await spawn($, 'worker', 'T1', 'haiku', 'RUN: R-b')).deny).toBeUndefined()
  })

  test('state ถูกเก็บลงไฟล์ และโหลดกลับตอนเริ่ม session ใหม่', async ($, on) => {
    const env = setup(on)
    const w = await spawn($, 'worker', 'T1', 'haiku', 'RUN: R-x')
    await finish($, w.agentId!, 'สถานะ: DONE\nผล test: ผ่าน')
    const r = await spawn($, 'reviewer', 'T1', 'sonnet', 'RUN: R-x')
    await finish($, r.agentId!, 'VERDICT: FIX')
    const saved = env.files.get('.claude/foreman/state.json') ?? ''
    expect(saved).toContain('"key": "R-x/T1"')
    expect(saved).toContain('"needsFix": true')
  })

  test('โหลด state: task ที่ปิดใน run เดิมยังปิดอยู่หลังเปิด session ใหม่', async ($, on) => {
    const env = setup(on)
    env.files.set('.claude/foreman/state.json', JSON.stringify({ version: 1, tasks: [{
      key: 'R-y/T1', run: 'R-y', isRunExplicit: true, id: 'T1', title: '', score: '2', skill: '-', isHighRisk: false,
      reviewTiers: ['sonnet'], reviews: 1, qaRuns: 0, needsFix: false, fixUsed: [], isClosed: true, result: 'PASS', tokensIn: 0, tokensOut: 0,
    }] }))
    await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
    expect((await spawn($, 'worker', 'T1', 'haiku', 'RUN: R-y')).deny).toContain('ปิดไปแล้ว')
  })

  test('log ตอน spawn worker มี run, คะแนน และระดับรีวิว', async ($, on) => {
    const env = setup(on)
    await spawn($, 'worker', 'T1', 'haiku', 'RUN: R-z\nระดับรีวิว: haiku\nQA: ต้อง')
    const first = JSON.parse((env.files.get('.claude/foreman-log.jsonl') ?? '').trim().split('\n')[0]!)
    expect(first).toMatchObject({ run: 'R-z', task: 'T1', score: '2', reviewLevel: 'haiku', qa: 'ต้อง', effort: 'medium' })
  })
})

describe('0.6: รีวิวรวมและไฟล์ซ้อน', () => {
  test('รีวิวรวม (TASK: FINAL) ต้องเป็น Opus', async ($, on) => {
    setup(on)
    const sonnet = await $.agent.spawn(spawnInput('TASK: FINAL — รีวิวรวม\nRUN: R-f\neffort: high', 'model-foreman:reviewer', 'sonnet'))
    expect(sonnet.deny).toContain('รีวิวรวมทั้งงาน')
    const opus = await $.agent.spawn(spawnInput('TASK: FINAL — รีวิวรวม\nRUN: R-f\neffort: high', 'model-foreman:reviewer', 'opus'))
    expect(opus.deny).toBeUndefined()
  })

  test('worker ที่ไฟล์ซ้อนกับ worker ที่ยังทำอยู่ถูกปฏิเสธ และส่งได้เมื่อตัวแรกเสร็จ', async ($, on) => {
    setup(on)
    const w1 = await spawn($, 'worker', 'T1', 'sonnet', 'ไฟล์: src/a.ts, `src/b.tsx`')
    expect(w1.deny).toBeUndefined()
    const clash = await spawn($, 'worker', 'T2', 'sonnet', 'ไฟล์: ./src/b.tsx, src/c.ts')
    expect(clash.deny).toContain('ซ้อนกับ T1 ที่ยังทำอยู่ (src/b.tsx)')
    const free = await spawn($, 'worker', 'T3', 'sonnet', 'ไฟล์: src/d.ts')
    expect(free.deny).toBeUndefined()
    await finish($, w1.agentId!, 'สถานะ: DONE')
    expect((await spawn($, 'worker', 'T2', 'sonnet', 'ไฟล์: ./src/b.tsx, src/c.ts')).deny).toBeUndefined()
  })

  test('log ตอน worker เสร็จบันทึก path ของ patch', async ($, on) => {
    const env = setup(on)
    const w = await spawn($, 'worker', 'T1', 'haiku', 'ไฟล์: src/a.ts')
    await finish($, w.agentId!, 'สถานะ: DONE\npatch: .claude/foreman/patches/R-T1.patch (1 ไฟล์, +2 -1)')
    const lines = (env.files.get('.claude/foreman-log.jsonl') ?? '').trim().split('\n').map(l => JSON.parse(l))
    expect(lines[0]).toMatchObject({ files: ['src/a.ts'] })
    expect(lines[1]).toMatchObject({ patch: '.claude/foreman/patches/R-T1.patch' })
  })
})


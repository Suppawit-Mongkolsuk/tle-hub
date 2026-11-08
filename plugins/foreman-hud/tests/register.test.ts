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
  `TASK: ${id} — ปุ่ม settings\nคะแนน: 2\nSKILL ที่ต้องโหลดก่อนเริ่ม: ui-guidelines\n${extra}`

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
    expect(env.toasts.at(-1)).toBe('T2 QA พบปัญหา ส่งต่อให้ reviewer')

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

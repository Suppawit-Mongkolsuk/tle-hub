# foreman-hud

mod ส่วนตัวสำหรับ [model-foreman](https://github.com/Suppawit-Mongkolsuk/Model-foreman) อยู่ใน hub tle-hub

## ทำอะไร

**บังคับกฎด้วยโค้ด** (ไม่พึ่งให้ Opus จำเอง) ใช้คู่กับ model-foreman 0.7.0 ขึ้นไป
- ทุก agent ต้องมีบรรทัด `effort: low / medium / high` ใน brief (ห้าม max)
- worker ต้องระบุ model (haiku / sonnet / opus) และห้ามลดระดับโมเดลของ task เดิม
- FIX ได้ 1 ครั้งต่อโมเดล (รวมรอบที่แก้ตาม QA) ครั้งที่สองต้องยกระดับ ส่วน `NEEDS_CONTEXT` ไม่นับ
- ได้ ESCALATE แล้วต้องส่งให้โมเดลที่สูงกว่าจริง ถ้า Opus ได้ ESCALATE ให้หยุดและรายงานผู้ใช้
- reviewer ต้องระบุ model และอยู่ระหว่าง**ขั้นต่ำ**ตาม rubric (ความเสี่ยงสูง / คะแนน 7+ / worker เป็น Opus / QA พบปัญหาระดับกลางขึ้นไป → Opus, คะแนน 4–6 → Sonnet, คะแนน 0–3 และ test ผ่าน → Haiku ได้) กับ**เพดาน**ในช่อง `ระดับรีวิว` ของ brief
- ถ้า reviewer ตอบ ESCALATE_REVIEW รอบถัดไปต้องเป็นระดับที่สูงกว่า (ยกเพดานตามไปด้วย)
- QA เป็น Sonnet เสมอ
- รีวิวรวมทั้งงาน (`TASK: FINAL`) ต้องเป็น Opus
- investigator (D-task) ต้องเป็น Sonnet ขึ้นไป ได้ `NOT_FOUND` / `PARTIAL` แล้วต้องส่ง Opus ต่อ ถ้า Opus ก็ไม่เจอให้หยุด
- worker ที่ช่อง `ไฟล์` ซ้อนกับ worker ที่ยังทำอยู่ถูกปฏิเสธ ให้รอตัวแรกเสร็จก่อน
- รีวิวไม่เกิน 5 ครั้งต่อ task ครั้งที่ 6 ถูกปฏิเสธและปิด task
- task ที่ผ่านหรือติดแล้วเรียกซ้ำไม่ได้ใน run เดิม (ใช้ task id เดิมใน run ใหม่ได้ ตามบรรทัด `RUN:` ใน brief)

**บันทึก log จากเหตุการณ์จริง** ในโปรเจกต์ที่กำลังทำงาน
- `.claude/foreman-log.jsonl` ทุกเหตุการณ์ (spawn / done / qa / verdict) พร้อม effort และ token จริง
- `.claude/router-log.md` หนึ่งแถวต่อ task ตอนปิด task พร้อมลำดับ reviewer ที่ใช้และ token in/out รวม
- `.claude/foreman/state.json` สถานะของ task (รวมสิทธิ์ FIX ที่ใช้ไป) ทำให้เปิด session ใหม่แล้วทำ run เดิมต่อได้

**แสดงสถานะ**
- status line: `Foreman · T2 Sonnet กำลังทำ · เสร็จ 1/3`
- toast: ผ่านรีวิว / ต้องยกระดับ / QA พบปัญหา / spec ไม่ชัด / session หลักไม่ได้ใช้ Opus

## ติดตั้ง

อยู่ใน hub `tle-hub` แล้ว

```
/plugin install foreman-hud@tle-hub
```

ตอนพัฒนา แก้ไฟล์ใน `plugins/foreman-hud` แล้วพิมพ์ `/reload-plugins`

## ใส่ในโปรเจกต์ที่ใช้งาน

เพิ่มลง `.gitignore` ของโปรเจกต์

```
.claude/router-log.md
.claude/foreman-log.jsonl
.claude/foreman/state.json
```

## ทดสอบ

```
claude plugin validate .
claude plugin test .
```

## ประวัติการแก้

**0.7.0** (ใช้คู่กับ model-foreman 0.7.0)
- รู้จัก agent `investigator`: บังคับ Sonnet ขึ้นไป, หาไม่เจอแล้วต้องยกระดับ, ปิด task เมื่อ `FOUND`
- log บันทึกต้นเหตุ ไฟล์ที่ต้องแก้ และว่าอยู่นอกขอบเขตไหม พร้อม toast เตือนเมื่อต้นเหตุอยู่นอกขอบเขต
- status line แสดง "หาสาเหตุ"

**0.6.0** (ใช้คู่กับ model-foreman 0.6.0)
- รีวิวรวมทั้งงาน (`TASK: FINAL`) ต้องเป็น Opus
- ปฏิเสธ worker ที่แก้ไฟล์ซ้อนกับ worker ที่ยังทำอยู่ (อ่านจากช่อง `ไฟล์:` ใน brief)
- log บันทึกรายการไฟล์ตอน spawn และ path ของ patch ตอน worker เสร็จ

**0.5.0** (ใช้คู่กับ model-foreman 0.5.0)
- อ่านรายงาน format ใหม่: สถานะ worker แบบ enum, ระดับปัญหาของ QA, toast เมื่อ worker ขอข้อมูล ติด หรือแย้ง feedback
- QA บังคับ Opus รีวิวเฉพาะปัญหาระดับกลางขึ้นไป
- เพดาน reviewer ตามช่อง `ระดับรีวิว` ใน brief
- นับสิทธิ์ FIX ต่อโมเดล และบังคับยกระดับหลัง ESCALATE
- บังคับ effort ใน brief
- run id จากบรรทัด `RUN:` และเก็บ state ลง `.claude/foreman/state.json`
- log ตอน spawn worker บันทึกคะแนน, ความเสี่ยง, QA, ระดับรีวิว และ skill

**0.4.0**
- "ไม่พบปัญหา" ไม่ถูกนับเป็น QA พบปัญหาอีกต่อไป (เดิมทำให้ต้องใช้ Opus รีวิวทุกครั้งที่มี QA)
- อ่านผล test ถูกต้อง: "12 passed, 0 failed" นับว่าผ่าน, "ไม่ผ่าน-มีอยู่เดิม" นับว่าไม่ผ่าน, ไม่มีผล test = ไม่รู้
- reviewer ที่ไม่ระบุ model ถูกปฏิเสธ พร้อมบอกระดับขั้นต่ำที่ต้องใช้

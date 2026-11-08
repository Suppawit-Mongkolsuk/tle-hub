# foreman-hud

mod ส่วนตัวสำหรับ [model-foreman](https://github.com/Suppawit-Mongkolsuk/Model-foreman) อยู่ใน hub tle-hub

## ทำอะไร

**บังคับกฎด้วยโค้ด** (ไม่พึ่งให้ Opus จำเอง)
- worker ต้องระบุ model (haiku / sonnet / opus)
- task เดิมห้ามลดระดับโมเดล (Sonnet แล้วกลับไป Haiku ไม่ได้)
- reviewer ต้องระบุ model เสมอ (ไม่ระบุ = ปฏิเสธ ไม่ใช้ Opus ให้อัตโนมัติ)
- reviewer ต้องไม่ต่ำกว่าระดับที่ rubric กำหนด (ความเสี่ยงสูง / คะแนน 7+ / worker เป็น Opus / QA พบปัญหา → Opus, คะแนน 4–6 → Sonnet, คะแนน 0–3 และ test ผ่าน → Haiku ได้)
- ถ้า reviewer ตอบ ESCALATE_REVIEW รอบถัดไปต้องเป็นระดับที่สูงกว่า
- QA เป็น Sonnet เสมอ
- รีวิวไม่เกิน 5 ครั้งต่อ task ครั้งที่ 6 ถูกปฏิเสธและปิด task
- task ที่ผ่านหรือติดแล้วเรียก worker ซ้ำไม่ได้

**บันทึก log จากเหตุการณ์จริง** ในโปรเจกต์ที่กำลังทำงาน
- `.claude/foreman-log.jsonl` ทุกเหตุการณ์ (spawn / done / qa / verdict) พร้อม effort และ token จริง
- `.claude/router-log.md` หนึ่งแถวต่อ task ตอนปิด task พร้อมลำดับ reviewer ที่ใช้และ token in/out รวม

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
```

## ทดสอบ

```
claude plugin validate .
claude plugin test .
```

## ประวัติการแก้

**0.4.0**
- "ไม่พบปัญหา" ไม่ถูกนับเป็น QA พบปัญหาอีกต่อไป (เดิมทำให้ต้องใช้ Opus รีวิวทุกครั้งที่มี QA)
- อ่านผล test ถูกต้อง: "12 passed, 0 failed" นับว่าผ่าน, "ไม่ผ่าน-มีอยู่เดิม" นับว่าไม่ผ่าน, ไม่มีผล test = ไม่รู้
- reviewer ที่ไม่ระบุ model ถูกปฏิเสธ พร้อมบอกระดับขั้นต่ำที่ต้องใช้

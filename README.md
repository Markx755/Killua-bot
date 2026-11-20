# Dynamic Voices — คู่มือภาษาไทย

บอท Discord สำหรับสร้างและจัดการห้องเสียงแบบไดนามิก สมาชิกเข้าห้องเสียงต้นทาง
แล้วบอทจะสร้างห้องเสียง ห้องข้อความ และ Role สำหรับควบคุมสิทธิ์ให้โดยอัฒนัตย์

> โปรเจกต์: `dynamic-voices` · เวอร์ชัน `0.2.0` · TypeScript · discord.js `14.14.1`
> Runtime ที่รองรับ: **Node.js 20 ขึ้นไป** (`engines.node: >=20.0.0`)

## สิ่งที่บอททำ

- สร้างห้องเสียงสาธารณะหรือส่วนตัวเมื่อสมาชิกเข้าห้องต้นทางที่กำหนด
- สร้างห้องข้อความและ Role คู่กับห้องเสียงทุกห้อง
- ย้ายสมาชิกเข้าห้องใหม่โดยอัตโนมัติ; ถ้าสร้างไม่สำเร็จจะย้อนคืนทรัพยากรที่สร้างไปแล้ว
- ลบห้องเสียง ห้องข้อความ และ Role เมื่อห้องว่าง (หรือเก็บห้องข้อความเป็นคลัง)
- จัดการสมาชิกในห้อง: เชิญ, นำออก, โอนความเป็นเจ้าของ
- เปลี่ยนชื่อห้อง, สลับการมองเห็น, เปิด/ปิด `inviteall`, เปิด/ปิด `archive`
- ตรวจสอบสิทธิ์ฝั่งเซิร์ฟเวอร์ก่อนทุกการกระทำที่ทำลายข้อมูล

## คำสั่ง Slash

### `/voice`

ใช้ได้เฉพาะในเซิร์ฟเวอร์ และต้องอยู่ในห้องไดนามิกหรืออยู่ในห้องข้อความของห้องนั้น

| คำสั่งย่อย | การทำงาน | ผู้มีสิทธิ์ |
|---|---|---|
| `/voice invite user:<user>` | เชิญสมาชิกเข้าห้อง | เจ้าของห้อง หรือสมาชิกในห้องเมื่อ `inviteall` เปิดอยู่ |
| `/voice kick user:<user>` | นำสมาชิกออกจากห้อง | เจ้าของห้องเท่านั้น |
| `/voice transfer user:<user>` | โอนความเป็นเจ้าของ | เจ้าของห้องเท่านั้น; ปลายทางต้องอยู่ในห้องและไม่ใช่บอท |
| `/voice rename name:<text>` | เปลี่ยนชื่อห้องเสียง/ข้อความ/Role | เจ้าของห้อง; มี cooldown 10 นาที |
| `/voice togglevisibility` | สลับสาธารณะ/ส่วนตัว | เจ้าของห้อง; มี cooldown 10 นาที |
| `/voice inviteall` | อนุญาตให้ทุกคนในห้องเชิญได้ | เจ้าของห้อง |
| `/voice archive` | เก็บห้องข้อความไว้เมื่อปิดห้อง | เจ้าของห้อง |
| `/voice info` | ดูข้อมูลห้อง | เจ้าของ, ผู้มีสิทธิ์จัดการเซิร์ฟเวอร์, หรือสมาชิกของห้อง |
| `/voice close` | ปิดและลบห้อง | **เจ้าของห้อง หรือผู้มีสิทธิ์ Administrator / ManageGuild เท่านั้น** |

การตอบกลับของ `/settings` และ `/voice` เป็น ephemeral สำหรับข้อมูลที่ละเอียดอ่อน
เพื่อไม่ให้สมาชิกทั่วไปเห็นค่าการตั้งค่า

### `/settings`

ต้องมีสิทธิ์ `ManageGuild` หรือ `Administrator` **ฝั่งเซิร์ฟเวอร์** (ตรวจซ้ำในโค้ด
ก่อนทุกการเขียนฐานข้อมูล ไม่ได้เชื่อเฉพาะ `defaultMemberPermissions`)

| คำสั่งย่อย | การทำงาน |
|---|---|
| `/settings view` | แสดงค่าที่ตั้งไว้ทั้งหมด |
| `/settings get key:<key>` | แสดงค่าของคีย์ที่เลือก |
| `/settings set key:<key> value:<snowflake>` | บันทึกไอดีช่องเสียงที่ระบุ |

คีย์ที่รองรับ:

- `NEW_PUBLIC_VOICECHANNEL` — ไอดีห้องเสียงต้นทางสำหรับสร้างห้องสาธารณะ
- `NEW_PRIVATE_VOICECHANNEL` — ไอดีห้องเสียงต้นทางสำหรับสร้างห้องส่วนตัว

ค่า `value` ต้องเป็น snowflake ของ **ช่องเสียง (GuildVoice) ที่มีอยู่จริงในเซิร์ฟเวอร์นี้**

## ความต้องการของระบบ

- Node.js 20 ขึ้นไป และ npm
- Discord Bot Token และ SERVER MEMBERS INTENT ที่เปิดใน Developer Portal
- Production: MySQL; Development: SQLite (`sqlite3` เป็น optional ที่ install script อาจถูกบล็อก
  ในบางสภาพแวดล้อม ใช้ MySQL หรือสิทธิ์ install scripts ที่เหมาะสม)

## ติดตั้ง และ Build

```bash
npm ci
npm run build     # tsc → dist/
npm test          # jest --runInBand
npm run lint      # eslint src/**/*.{ts,js}
```

## ตั้งค่า Environment

```bash
cp .env.preset .env
```

กำหนดใน `.env` (ห้าม commit ไฟล์นี้ — `.gitignore` บล็อก `.env` และ `.env.*` ไว้แล้ว):

```env
DD_DISCORD_BOT_TOKEN=<token ของบอท>

# เฉพาะโหมด Production (NODE_ENV=production)
DD_DBPROD_HOST=db.internal
DD_DBPROD_PORT=3306
DD_DBPROD_NAME=voices
DD_DBPROD_USER=bot
DD_DBPROD_PASS=<รหัสผ่าน>

# ไม่บังคับ
# DD_SQLITE_STORAGE=./database.sqlite
# DD_LOG_DIR=logs
```

ตารางตัวแปร:

| ตัวแปร | บังคับ | ใช้เมื่อ | หมายเหตุ |
|---|---|---|---|
| `DD_DISCORD_BOT_TOKEN` | ทุกโหมด | ทุกโหมด | ต้องมีลักษณะเป็น token จริง; ค่าตัวอย่าง จะถูกปฏิเสธก่อน login |
| `NODE_ENV` | ไม่ | ทุกโหมด | `production` เลือก MySQL; ค่าอื่นเลือก SQLite |
| `DD_DBPROD_HOST` | ใช่ | production | host ของ MySQL |
| `DD_DBPROD_PORT` | ไม่ | production | ค่าเริ่มต้น 3306; ต้องเป็นเลข 1–65535 |
| `DD_DBPROD_NAME` | ใช่ | production | ชื่อฐานข้อมูล |
| `DD_DBPROD_USER` | ใช่ | production | ชื่อผู้ใช้ |
| `DD_DBPROD_PASS` | ใช่ | production | รหัสผ่าน; ไม่ถูก log |
| `DD_SQLITE_STORAGE` | ไม่ | development | ค่าเริ่มต้น `./database.sqlite` |
| `DD_LOG_DIR` | ไม่ | ทุกโหมด | ค่าเริ่มต้น `logs/`; สร้างอัตโนมัติ |

แอปพลิเคชันอ่านค่าเหล่านี้ครั้งเดียวตอนเริ่มต้น (`src/config.ts`) ถ้าขาดตัวแปรบังคับ
หรือค่าไม่ถูกต้อง กระบวนการจะจบด้วยรหัส 1 **ก่อน** login และก่อนเชื่อมฐานข้อมูล

## เริ่มต้นใช้งาน

Development:

```bash
npm run dev
```

Production:

```bash
npm run build
NODE_ENV=production npm start
```

`npm start` รัน `node dist/bot.js` (ตรงกับ `main` ใน package.json)

ลำดับการเริ่มต้น: โหลด/ตรวจ env → authenticate ฐานข้อมูล → `sequelize.sync()`
(await) → login Discord → register/correct slash commands (await) → log ว่า ready
→ ถ้าขั้นตอนใดล้มเหลว กระบวนการจะจบและปิดการเชื่อมต่อก่อนเสมอ

## ตั้งค่าห้องต้นทางใน Discord

1. เปิด Developer Mode แล้วสร้างห้องเสียงต้นทางสำหรับห้องสาธารณะและส่วนตัว
2. ใช้ `/settings set` กำหนด `NEW_PUBLIC_VOICECHANNEL` และ `NEW_PRIVATE_VOICECHANNEL`
   ให้เป็นไอดีของห้องที่ตรงกัน
3. ตรวจสอบสิทธิ์บอท: จัดการช่อง, จัดการ Role, ดูช่อง, ย้ายสมาชิก, เชิญสมาชิก
4. วาง Role ของบอทให้สูงกว่า Role ที่บอทต้องสร้าง/ลบ
5. ทดสอบในเซิร์ฟเวอร์ทดสอบก่อนเปิดใช้งานจริง

## Deploy ด้วย PM2

```bash
npm run build
pm2 start ecosystem.config.js --env production
pm2 logs dynamic-voices
```

`ecosystem.config.js` กำหนด `logs/error.log`, `logs/out.log` และ `logs/combined.log`
บนแพลตฟอร์มที่ใช้ filesystem ชั่วคราว ให้ใช้ MySQL แทน SQLite และตั้ง `DD_LOG_DIR`
ไปยังโฟลเดอร์ที่เก็บข้อมูลได้ถาวร

## การแก้ปัญหา

| อาการ | สาเหตุ | การแก้ |
|---|---|---|
| `DD_DISCORD_BOT_TOKEN is required` | ไม่มี token ใน env | สร้าง `.env` จาก `.env.preset` และใส่ token |
| `does not look like a valid Discord bot token` | ใส่ placeholder หรือ token สั้นเกินไป | ใช้ token จริงจาก Developer Portal |
| `Missing required production database variable(s)` | ใช้ `NODE_ENV=production` แต่ไม่ได้ตั้งค่าฐานข้อมูล | ตั้ง `DD_DBPROD_HOST/NAME/USER/PASS` |
| `Database authentication failed` | host/user/password ผิด หรือ MySQL ยังไม่พร้อม | ตรวจค่าต่อท้ายและสถานะเซิร์ฟเวอร์; บอทจะไม่ online ในกรณีนี้ |
| `Database synchronisation failed` | สิทธิ์ CREATE/ALTER ของผู้ใช้ฐานข้อมูลไม่พอ | ให้สิทธิ์ DDL แก่ผู้ใช้บอทหรือสร้าง schema ล่วงหน้า |
| `Command registry updated successfully` ไม่ปรากฏ | register ยังไม่เสร็จหรือ login ล้มเหลว | ดู `logs/error.log` แล้วแก้ตามข้อความจริง |
| `SQLite cant open database` | ไดเรกทอรีหรือ native binding ของ `sqlite3` ไม่พร้อม | ตั้ง `DD_SQLITE_STORAGE` ให้ชี้ที่-path ที่เขียนได้ หรืออนุญาต install scripts |
| `/voice close` ตอบว่าไม่มีสิทธิ์ | ผู้ใช้ไม่ใช่เจ้าของห้องและไม่มี Administrator/ManageGuild | ให้เจ้าของห้องเป็นคนปิด หรือโอนห้องก่อน |
| `คุณต้องรออีก ... นาที` | cooldown 10 นาทีหลัง rename/togglevisibility | รอให้ครบ then ลองใหม่ |

ข้อความ error ที่ส่งถึงผู้ใช้เป็นข้อความทั่วไป รายละเอียดถูกเขียนลง `logs/error.log`
แบบกรอง token/รหัสผ่านออกแล้ว (`src/config.ts` → `redactSecrets`)

## ความปลอดภัย (summary)

- `/voice close`: เจ้าของหรือผู้ดูแลเท่านั้น; ตรวจก่อนลบ และลบ DB record หลัง Discord API สำเร็จเท่านั้น
- `/settings`: ตรวจ `ManageGuild`/`Administrator` ฝั่งเซิร์ฟเวอร์, ตรวจ allowlist ของ key,
  และตรวจว่าค่าเป็นช่องเสียงที่มีอยู่จริงใน guild เดียวกัน
- ทุก handler ตรวจ guild context และความเป็นเจ้าของทรัพยากร (guild-scoped query)
- input ของ rename ถูก trim และปฏิเสธอักขระควบคุม/``@`, `#`, `:`, `` ` ``
- ไม่มี token หรือรหัสผ่านในซอร์สโค้ด; `.env` ถูกกันออกจาก repository

## License

GPL-3.0 — ดู `LICENSE.txt` และคงข้อความลิขสิทธิ์ไว้เมื่อแจกจ่ายเวอร์ชันดัดแปลง

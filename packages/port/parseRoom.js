'use strict';
/*
 * parseRoom.js — 무한 MUD (Mordor 파생) 방 파일 파서 PoC
 *
 * 디스크 포맷 (files1.c write_rom, 32비트 ABI: long=4, ptr=4):
 *   [room 구조체 480B]
 *   [int 출구수] [exit_ 44B] × n
 *   [int 몬스터수] [creature ...] × n   (write_crt: 1184B + int invcnt + obj들)
 *   [int 아이템수] [object ...] × n      (write_obj: 352B + int cnt + 중첩 obj들)
 *   [int len] [short_desc]  [int len] [long_desc]  [int len] [obj_desc]
 *
 * 모든 정수 little-endian. 텍스트 EUC-KR.
 */

const SZ = { room: 480, exit_: 44, object: 352, creature: 1184 };
const OFF = {
  room: { rom_num: 0, name: 2, lolevel: 96, hilevel: 97, special: 98,
          trap: 100, trapexit: 102, track: 104, flags: 184, random: 192,
          traffic: 212, perm_mon: 216 },
  exit_: { name: 0, room: 20, flags: 22, key: 40 },
  object: { name: 0, description: 80, value: 300, type: 119 /* 추정: 미사용 PoC */ },
  creature: { name: 0, level: -1 /* 아래서 직접 계산 안 함, 이름만 */, rom_num: 458 },
};

const dec = new TextDecoder('euc-kr');

function cstr(buf, start, max) {
  let end = start;
  const limit = start + max;
  while (end < limit && buf[end] !== 0) end++;
  return dec.decode(buf.subarray(start, end));
}

class Cursor {
  constructor(buf) { this.buf = buf; this.off = 0; }
  i32() { const v = this.buf.readInt32LE(this.off); this.off += 4; return v; }
  remaining() { return this.buf.length - this.off; }
}

// write_obj: object(352) + int cnt + 중첩 obj들
function parseObject(c) {
  const base = c.off;
  const b = c.buf;
  const obj = {
    name: cstr(b, base + OFF.object.name, 80),
    description: cstr(b, base + OFF.object.description, 80),
    value: b.readInt32LE(base + OFF.object.value),
  };
  c.off += SZ.object;
  const cnt = c.i32();
  obj.contains = [];
  for (let i = 0; i < cnt; i++) obj.contains.push(parseObject(c));
  return obj;
}

// write_crt: creature(1184) + int invcnt + obj들
function parseCreature(c) {
  const base = c.off;
  const b = c.buf;
  const crt = {
    name: cstr(b, base + OFF.creature.name, 80),
    rom_num: b.readInt16LE(base + OFF.creature.rom_num),
  };
  c.off += SZ.creature;
  const cnt = c.i32();
  crt.inventory = [];
  for (let i = 0; i < cnt; i++) crt.inventory.push(parseObject(c));
  return crt;
}

function parseExit(buf, base) {
  return {
    name: cstr(buf, base + OFF.exit_.name, 20),
    room: buf.readInt16LE(base + OFF.exit_.room),
    flags: Array.from(buf.subarray(base + OFF.exit_.flags, base + OFF.exit_.flags + 4)),
    key: buf.readInt8(base + OFF.exit_.key),
  };
}

function parseRoom(buf) {
  const c = new Cursor(buf);
  const b = buf;
  const room = {
    rom_num: b.readInt16LE(OFF.room.rom_num),
    name: cstr(b, OFF.room.name, 80),
    lolevel: b.readInt8(OFF.room.lolevel),
    hilevel: b.readInt8(OFF.room.hilevel),
    special: b.readInt16LE(OFF.room.special),
    trap: b.readInt8(OFF.room.trap),
    flags: Array.from(b.subarray(OFF.room.flags, OFF.room.flags + 8)),
    track: cstr(b, OFF.room.track, 80),
  };

  // 스폰 데이터 (room 구조체 480B 내부 고정 필드; 커서 미이동)
  // random: short[10] 랜덤 스폰 몹번호. traffic: 스폰 확률(char).
  room.random = [];
  for (let i = 0; i < 10; i++) room.random.push(b.readInt16LE(OFF.room.random + i * 2));
  room.traffic = b.readInt8(OFF.room.traffic);
  // perm_mon: lasttime[10] (각 12B: interval long, ltime long, misc short) 고정 스폰 몹.
  room.perm_mon = [];
  for (let i = 0; i < 10; i++) {
    const o = OFF.room.perm_mon + i * 12;
    room.perm_mon.push({
      interval: b.readInt32LE(o),
      ltime: b.readInt32LE(o + 4),
      misc: b.readInt16LE(o + 8),
    });
  }

  c.off = SZ.room;

  // 출구
  const nExit = c.i32();
  room.exits = [];
  for (let i = 0; i < nExit; i++) {
    room.exits.push(parseExit(b, c.off));
    c.off += SZ.exit_;
  }

  // 몬스터
  const nMon = c.i32();
  room.monsters = [];
  for (let i = 0; i < nMon; i++) room.monsters.push(parseCreature(c));

  // 아이템
  const nItem = c.i32();
  room.items = [];
  for (let i = 0; i < nItem; i++) room.items.push(parseObject(c));

  // 설명 3종 (length-prefixed)
  const readDesc = () => {
    const len = c.i32();
    if (len <= 0) return '';
    const s = dec.decode(b.subarray(c.off, c.off + len - 1)); // NUL 제외
    c.off += len;
    return s;
  };
  room.short_desc = readDesc();
  room.long_desc = readDesc();
  room.obj_desc = readDesc();

  room._leftover = c.remaining(); // 0이어야 완벽 파싱
  return room;
}

module.exports = { parseRoom, parseObject, parseCreature, SZ, OFF };

// CLI: node parseRoom.js <roomfile> [--json]
if (require.main === module) {
  const fs = require('fs');
  const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const asJson = process.argv.includes('--json');
  for (const f of files) {
    const buf = fs.readFileSync(f);
    const r = parseRoom(buf);
    if (asJson) { console.log(JSON.stringify(r, null, 2)); continue; }
    console.log(`\n=== ${f} (size ${buf.length}) ===`);
    console.log(`방번호: ${r.rom_num}  이름: ${r.name}`);
    console.log(`레벨: ${r.lolevel}-${r.hilevel}  leftover: ${r._leftover} ${r._leftover === 0 ? '✓완벽' : '✗불일치'}`);
    console.log(`출구(${r.exits.length}): ` + r.exits.map((e) => `${e.name}->${e.room}`).join(', '));
    if (r.monsters.length) console.log(`몬스터(${r.monsters.length}): ` + r.monsters.map((m) => m.name).join(', '));
    if (r.items.length) console.log(`아이템(${r.items.length}): ` + r.items.map((o) => o.name).join(', '));
    if (r.short_desc) console.log(`단설명: ${r.short_desc.replace(/\r?\n/g, ' ').slice(0, 80)}`);
    if (r.long_desc) console.log(`장설명: ${r.long_desc.replace(/\r?\n/g, ' ').slice(0, 120)}`);
  }
}

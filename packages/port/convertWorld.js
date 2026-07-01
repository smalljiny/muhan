'use strict';
/*
 * convertWorld.js — 전체 월드(rooms + objmon 템플릿)를 JSON으로 변환.
 *   node convertWorld.js <muhanRoot> <outDir> [--pretty]
 * 산출: <outDir>/rooms/r#####.json, <outDir>/objects.json, <outDir>/creatures.json
 */
const fs = require('fs');
const path = require('path');
const { parseRoom } = require('./parseRoom.js');
const { readObject, readCreature, SZ } = require('./templates.js');

function convert(root, outDir, pretty) {
  const ind = pretty ? 2 : 0;
  const stat = { rooms: 0, roomBytes: 0, objects: 0, creatures: 0, badRooms: 0, orphans: 0 };
  const roomsDir = path.join(outDir, 'rooms');
  fs.mkdirSync(roomsDir, { recursive: true });

  // --- rooms ---
  // 방 ID = 로드 경로의 번호. 원본 공식: rooms/r{N/1000}/r{N:05d}.
  // 디렉터리가 N/1000과 안 맞는 파일은 게임이 로드 불가한 orphan → 제외.
  const rRoot = path.join(root, 'rooms');
  for (const d of fs.readdirSync(rRoot)) {
    const dirPath = path.join(rRoot, d);
    if (!fs.statSync(dirPath).isDirectory()) continue;
    for (const base of fs.readdirSync(dirPath)) {
      const m = /^r(\d+)$/.exec(base);
      if (!m) continue; // ~백업/비정형 제외
      const num = parseInt(m[1], 10);
      if (d !== 'r' + String(Math.floor(num / 1000)).padStart(2, '0')) { stat.orphans++; continue; }
      let r;
      try { r = parseRoom(fs.readFileSync(path.join(dirPath, base))); } catch { stat.badRooms++; continue; }
      if (r._leftover !== 0) stat.badRooms++;
      delete r._leftover;
      const js = JSON.stringify({ id: num, ...r }, null, ind);
      fs.writeFileSync(path.join(roomsDir, `r${String(num).padStart(5, '0')}.json`), js);
      stat.rooms++; stat.roomBytes += Buffer.byteLength(js);
    }
  }

  // --- objects (o##) / creatures (m##) ---
  const omDir = path.join(root, 'objmon');
  const objs = [], crts = [];
  for (const f of fs.readdirSync(omDir).sort()) {
    const m = /^([om])(\d\d)$/.exec(f);
    if (!m) continue;
    const buf = fs.readFileSync(path.join(omDir, f));
    const base = +m[2] * 100; // o05 → 인덱스 500..599
    const n = Math.floor(buf.length / (m[1] === 'o' ? SZ.object : SZ.creature));
    for (let i = 0; i < n; i++) {
      if (m[1] === 'o') { const o = readObject(buf, i * SZ.object); if (o.name) objs.push({ id: base + i, ...o }); }
      else { const c = readCreature(buf, i * SZ.creature); if (c.name) crts.push({ id: base + i, ...c }); }
    }
  }
  const objJson = JSON.stringify(objs, null, ind);
  const crtJson = JSON.stringify(crts, null, ind);
  fs.writeFileSync(path.join(outDir, 'objects.json'), objJson);
  fs.writeFileSync(path.join(outDir, 'creatures.json'), crtJson);
  stat.objects = objs.length; stat.creatures = crts.length;
  stat.objBytes = Buffer.byteLength(objJson); stat.crtBytes = Buffer.byteLength(crtJson);
  return stat;
}

if (require.main === module) {
  const [root, outDir] = process.argv.slice(2);
  const pretty = process.argv.includes('--pretty');
  const t0 = process.hrtime.bigint();
  const s = convert(root, outDir, pretty);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(JSON.stringify({ ...s, ms: Math.round(ms), pretty }, null, 2));
}
module.exports = { convert };

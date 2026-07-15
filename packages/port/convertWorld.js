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
  const bundle = [];
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
      const room = { id: num, ...r };
      const js = JSON.stringify(room, null, ind);
      fs.writeFileSync(path.join(roomsDir, `r${String(num).padStart(5, '0')}.json`), js);
      bundle.push(room);
      stat.rooms++; stat.roomBytes += Buffer.byteLength(js);
    }
  }
  // 번들 rooms.json — id 오름차순 정렬(결정적 산출물).
  bundle.sort((a, b) => a.id - b.id);
  fs.writeFileSync(path.join(outDir, 'rooms.json'), JSON.stringify(bundle, null, ind));

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

  // --- meta.json (결정적: 타임스탬프 없음, 실측 counts) ---
  // bundle은 line 43에서 id 오름차순 정렬됨 → 첫/끝이 min/max. 빈 배열도 안전.
  const roomIdRange = bundle.length ? [bundle[0].id, bundle[bundle.length - 1].id] : [];
  const meta = {
    generatedFrom: 'legacy/muhan (Mordor 파생 무한 MUD)',
    encoding: 'EUC-KR→UTF-8',
    counts: { rooms: bundle.length, objects: objs.length, creatures: crts.length },
    roomIdRange,
    notes: '방 ID=원본 로드경로 번호(rooms/r{N/1000}/r{N:05d}). orphan 제외. 구조체 필드 오프셋은 32비트 C oracle로 검증.',
    files: {
      perRoom: 'rooms/r#####.json',
      roomsBundle: 'rooms.json',
      objects: 'objects.json',
      creatures: 'creatures.json',
    },
  };
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));
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

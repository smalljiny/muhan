'use strict';
/*
 * templates.js — objmon/o##(object), m##(creature) 평면 구조체 배열 파서.
 * 각 파일 = 100개 고정크기 구조체 (object=352B, creature=1184B), lseek(index*size).
 * 전 필드 추출 + oracle.c와 동일한 정규 라인 출력(필드 오프셋 검증용).
 * 문자열은 NUL까지 raw 바이트 hex로 출력 → 인코딩 독립 비교.
 */

const SZ = { object: 352, creature: 1184 };

// object 필드 오프셋 (32비트 ABI)
const OBJ = {
  name: 0, description: 80, key: 160, use_output: 220, value: 300, weight: 304,
  type: 306, adjustment: 307, shotsmax: 308, shotscur: 310, ndice: 312, sdice: 314,
  pdice: 316, armor: 318, wearflag: 319, magicpower: 320, magicrealm: 321,
  special: 322, flags: 324, questnum: 332, first_obj: 336,
};
// creature 필드 오프셋
const CRT = {
  name: 0, description: 80, talk: 160, password: 240, key: 255, fd: 316, level: 318,
  type: 319, class: 320, race: 321, numwander: 322, alignment: 324, strength: 326,
  dexterity: 327, constitution: 328, intelligence: 329, piety: 330, hpmax: 332,
  hpcur: 334, mpmax: 336, mpcur: 338, armor: 340, thaco: 341, experience: 344,
  gold: 348, ndice: 352, sdice: 354, pdice: 356, special: 358, proficiency: 360,
  realm: 380, spells: 396, flags: 412, quests: 420, questnum: 436, carry: 438,
  rom_num: 458, ready: 460, daily: 540, lasttime: 620, first_obj: 1168, parent_rom: 1180,
};

const dec = new TextDecoder('euc-kr');
function cstr(b, s, max) { let e = s; const lim = s + max; while (e < lim && b[e] !== 0) e++; return dec.decode(b.subarray(s, e)); }
function hexToNul(b, s, max) { let e = s; const lim = s + max; while (e < lim && b[e] !== 0) e++; return b.subarray(s, e).toString('hex'); }
function hexFixed(b, s, n) { return b.subarray(s, s + n).toString('hex'); }

function readObject(b, base = 0) {
  const o = (k) => base + OBJ[k];
  return {
    name: cstr(b, o('name'), 80), description: cstr(b, o('description'), 80),
    value: b.readInt32LE(o('value')), weight: b.readInt16LE(o('weight')),
    type: b.readInt8(o('type')), adjustment: b.readInt8(o('adjustment')),
    shotsmax: b.readInt16LE(o('shotsmax')), shotscur: b.readInt16LE(o('shotscur')),
    ndice: b.readInt16LE(o('ndice')), sdice: b.readInt16LE(o('sdice')), pdice: b.readInt16LE(o('pdice')),
    armor: b.readInt8(o('armor')), wearflag: b.readInt8(o('wearflag')),
    magicpower: b.readInt8(o('magicpower')), magicrealm: b.readInt8(o('magicrealm')),
    special: b.readInt16LE(o('special')), questnum: b.readInt8(o('questnum')),
    flags: hexFixed(b, o('flags'), 8),
  };
}

function readCreature(b, base = 0) {
  const c = (k) => base + CRT[k];
  return {
    name: cstr(b, c('name'), 80), description: cstr(b, c('description'), 80), talk: cstr(b, c('talk'), 80),
    level: b.readUInt8(c('level')), type: b.readInt8(c('type')), class: b.readInt8(c('class')),
    race: b.readInt8(c('race')), numwander: b.readInt16LE(c('numwander')),
    alignment: b.readInt16LE(c('alignment')),
    strength: b.readInt8(c('strength')), dexterity: b.readInt8(c('dexterity')),
    constitution: b.readInt8(c('constitution')), intelligence: b.readInt8(c('intelligence')),
    piety: b.readInt8(c('piety')), hpmax: b.readInt16LE(c('hpmax')), hpcur: b.readInt16LE(c('hpcur')),
    mpmax: b.readInt16LE(c('mpmax')), mpcur: b.readInt16LE(c('mpcur')),
    armor: b.readInt8(c('armor')), thaco: b.readInt8(c('thaco')),
    experience: b.readInt32LE(c('experience')), gold: b.readInt32LE(c('gold')),
    ndice: b.readInt16LE(c('ndice')), sdice: b.readInt16LE(c('sdice')), pdice: b.readInt16LE(c('pdice')),
    special: b.readInt16LE(c('special')), rom_num: b.readInt16LE(c('rom_num')),
    flags: hexFixed(b, c('flags'), 8), spells: hexFixed(b, c('spells'), 16),
  };
}

// oracle.c와 글자 단위로 동일한 정규 라인
function lineObj(b, base, i) {
  const o = (k) => base + OBJ[k];
  return `OBJ ${i} value=${b.readInt32LE(o('value'))} weight=${b.readInt16LE(o('weight'))} ` +
    `type=${b.readInt8(o('type'))} adjustment=${b.readInt8(o('adjustment'))} ` +
    `shotsmax=${b.readInt16LE(o('shotsmax'))} shotscur=${b.readInt16LE(o('shotscur'))} ` +
    `ndice=${b.readInt16LE(o('ndice'))} sdice=${b.readInt16LE(o('sdice'))} pdice=${b.readInt16LE(o('pdice'))} ` +
    `armor=${b.readInt8(o('armor'))} wearflag=${b.readInt8(o('wearflag'))} ` +
    `magicpower=${b.readInt8(o('magicpower'))} magicrealm=${b.readInt8(o('magicrealm'))} ` +
    `special=${b.readInt16LE(o('special'))} questnum=${b.readInt8(o('questnum'))} ` +
    `namehex=${hexToNul(b, o('name'), 80)} deschex=${hexToNul(b, o('description'), 80)} ` +
    `flagshex=${hexFixed(b, o('flags'), 8)}`;
}
function lineCrt(b, base, i) {
  const c = (k) => base + CRT[k];
  return `CRT ${i} level=${b.readUInt8(c('level'))} type=${b.readInt8(c('type'))} ` +
    `class=${b.readInt8(c('class'))} race=${b.readInt8(c('race'))} alignment=${b.readInt16LE(c('alignment'))} ` +
    `str=${b.readInt8(c('strength'))} dex=${b.readInt8(c('dexterity'))} con=${b.readInt8(c('constitution'))} ` +
    `int=${b.readInt8(c('intelligence'))} pie=${b.readInt8(c('piety'))} ` +
    `hpmax=${b.readInt16LE(c('hpmax'))} hpcur=${b.readInt16LE(c('hpcur'))} ` +
    `mpmax=${b.readInt16LE(c('mpmax'))} mpcur=${b.readInt16LE(c('mpcur'))} ` +
    `armor=${b.readInt8(c('armor'))} thaco=${b.readInt8(c('thaco'))} ` +
    `experience=${b.readInt32LE(c('experience'))} gold=${b.readInt32LE(c('gold'))} ` +
    `ndice=${b.readInt16LE(c('ndice'))} sdice=${b.readInt16LE(c('sdice'))} pdice=${b.readInt16LE(c('pdice'))} ` +
    `special=${b.readInt16LE(c('special'))} rom_num=${b.readInt16LE(c('rom_num'))} ` +
    `namehex=${hexToNul(b, c('name'), 80)} talkhex=${hexToNul(b, c('talk'), 80)} ` +
    `flagshex=${hexFixed(b, c('flags'), 8)} spellshex=${hexFixed(b, c('spells'), 16)}`;
}

module.exports = { readObject, readCreature, SZ, OBJ, CRT };

// CLI: node templates.js obj|crt <file> [count]  → 정규 라인 출력
if (require.main === module) {
  const fs = require('fs');
  const [kind, file, countArg] = process.argv.slice(2);
  const b = fs.readFileSync(file);
  const sz = kind === 'obj' ? SZ.object : SZ.creature;
  const count = Math.min(countArg ? +countArg : 100, Math.floor(b.length / sz));
  const out = [];
  for (let i = 0; i < count; i++) out.push(kind === 'obj' ? lineObj(b, i * sz, i) : lineCrt(b, i * sz, i));
  process.stdout.write(out.join('\n') + '\n');
}

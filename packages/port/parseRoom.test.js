'use strict';
/*
 * parseRoom 스폰 필드 추출 테스트 (node:test).
 * 픽스처: 방 135 (비영 스폰 방). 오라클 offsetof 리터럴과 대조.
 *   traffic=10, random[0]=13, perm_mon[0/1]={interval:100, ltime:8716403xx, misc:123}.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseRoom, OFF } = require('./parseRoom.js');
const { OBJ } = require('./templates.js');

// 픽스처: 방 135(스폰 필드) · 방 50(바닥 아이템) · 방 423(중첩 인벤토리 — 눈알귀신 2점·소녀 29점).
const loadRoom = (id) => parseRoom(fs.readFileSync(
  path.join(__dirname, `../../legacy/muhan/rooms/r00/r${String(id).padStart(5, '0')}`)));

const room135 = () => loadRoom(135);
const room50 = () => loadRoom(50);
const room423 = () => loadRoom(423);

// readKeys 위생 계약(templates.js): 보관값은 비지 않고 이미 trim된 상태다.
function assertKeysSane(keys, label) {
  assert.ok(Array.isArray(keys), `${label} keys가 배열이 아님`);
  for (const k of keys) {
    assert.ok(k.length > 0 && k.trim() === k, `${label} 위생 위반: ${JSON.stringify(k)}`);
  }
}

// D8: scavenge 제외 판정에 바닥 아이템 object flags(offset 324, 8B hex)가 필요하다.
// 방 50 바닥 아이템(숨겨진 돈주머니)은 raw flags 0300(OPERMT|OHIDDN) → scavenge 제외 대상.
test('parseObject가 flags(offset 324, 8B hex)를 emit한다 (방50 돈주머니 0300)', () => {
  const r = room50();
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].name, '숨겨진 돈주머니');
  assert.equal(r.items[0].flags, '0300000000000000');
});

test('OFF.object.flags 오프셋은 오라클 324', () => {
  assert.equal(OFF.object.flags, 324);
});

test('object flags 추가 후에도 방50 _leftover===0 (아이템 파싱 경로 불변)', () => {
  assert.equal(room50()._leftover, 0);
});

// Story 1: 리더 2종이 `char key[3][20]` 별칭을 keys: string[]로 추출한다.
// object.key@160 (mstruct.h: name[80]@0, description[80]@80, key[3][20]@160).
// creature 경로는 parseCreature → readCreature 위임이라 templates.js 변경이 자동 전파된다.
test('OFF.object.key는 오라클 160이며 templates.js OBJ에서 파생된다 (리터럴 복제 금지)', () => {
  assert.equal(OFF.object.key, 160);
  assert.equal(OFF.object.key, OBJ.key);
});

test('embedded 몬스터가 keys 배열을 보유한다 (방135)', () => {
  const r = room135();
  assert.ok(r.monsters.length > 0);
  for (const m of r.monsters) assertKeysSane(m.keys, m.name);
});

test('바닥 아이템이 keys 배열을 보유한다 (방50 숨겨진 돈주머니)', () => {
  const r = room50();
  assert.equal(r.items.length, 1);
  assertKeysSane(r.items[0].keys, r.items[0].name);
});

// rooms/*.json 산출물 diff 안정성 — parseObject도 C struct 순서(description 뒤)를 따른다.
test('parseObject는 keys를 description 뒤에 둔다 (JSON 키 순서 고정)', () => {
  const order = Object.keys(room50().items[0]);
  assert.equal(order[order.indexOf('description') + 1], 'keys');
});

// 중첩 인벤토리·컨테이너도 같은 재귀 parseObject 경로를 타므로 keys를 보유한다.
test('중첩 인벤토리 아이템도 keys 배열을 보유한다 (방423 재귀 경로 회귀)', () => {
  const r = room423();
  let nested = 0;
  let realAlias = 0;
  const walk = (o) => {
    assertKeysSane(o.keys, o.name);
    nested++;
    for (const k of o.keys) if (!o.name.startsWith(k)) realAlias++;
    for (const c of o.contains) walk(c);
  };
  for (const m of r.monsters) for (const o of m.inventory) walk(o);
  assert.ok(nested >= 31, `중첩 아이템 ${nested} < 31`);
  // '회색 지팡이' → ['지팡이','회색'] 처럼 name 접두가 아닌 진짜 별칭이 중첩 경로에도 실린다.
  assert.ok(realAlias > 0, '중첩 아이템에 진짜 별칭이 하나도 없다');
  assert.equal(r._leftover, 0);
});

test('keys 추가 후에도 방135·방50 _leftover===0 (커서 불변 회귀 가드)', () => {
  assert.equal(room135()._leftover, 0);
  assert.equal(room50()._leftover, 0);
});

test('OFF.room.perm_mon 오프셋은 오라클 offsetof 216', () => {
  assert.equal(OFF.room.perm_mon, 216);
});

test('traffic는 int8 확률 10', () => {
  assert.equal(room135().traffic, 10);
});

test('random은 길이 10 short 배열, [0]=13 나머지 0', () => {
  const r = room135();
  assert.ok(Array.isArray(r.random));
  assert.equal(r.random.length, 10);
  assert.deepEqual(r.random, [13, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
});

test('perm_mon은 길이 10, 각 {interval,ltime,misc}, [0]/[1] 오라클 리터럴', () => {
  const r = room135();
  assert.ok(Array.isArray(r.perm_mon));
  assert.equal(r.perm_mon.length, 10);
  assert.deepEqual(r.perm_mon[0], { interval: 100, ltime: 871640363, misc: 123 });
  assert.deepEqual(r.perm_mon[1], { interval: 100, ltime: 871640364, misc: 123 });
  for (let i = 2; i < 10; i++) {
    assert.deepEqual(r.perm_mon[i], { interval: 0, ltime: 0, misc: 0 });
  }
});

test('스폰 필드 추가 후에도 _leftover===0 (가변 꼬리 회귀 가드)', () => {
  assert.equal(room135()._leftover, 0);
});

// D6: embedded 몬스터는 완전한 1184B creature 구조체다. parseCreature가
// templates.js readCreature 재사용으로 전체 스탯을 emit해야 한다(name+rom_num만이 아님).
test('embedded 몬스터가 readCreature 전체 필드를 갖는다 (좀도둑: hpmax 7·level 4·gold 80·dex 14)', () => {
  const r = room135();
  assert.equal(r.monsters.length, 2);
  const thief = r.monsters[0];
  assert.equal(thief.name, '좀도둑');
  assert.equal(thief.rom_num, 135);
  assert.equal(thief.level, 4);
  assert.equal(thief.hpmax, 7);
  assert.equal(thief.hpcur, 7);
  assert.equal(thief.mpmax, 0);
  assert.equal(thief.mpcur, 0);
  assert.equal(thief.gold, 80);
  assert.equal(thief.dexterity, 14);
  // flags는 creatures.json과 동일 hex string 표현.
  assert.equal(thief.flags, '0112000000000000');
});

test('embedded 몬스터 inventory 배열이 유지된다 (중첩 obj 파싱 경로 불변)', () => {
  const r = room135();
  for (const m of r.monsters) {
    assert.ok(Array.isArray(m.inventory));
  }
});

test('embedded 몬스터 스탯은 템플릿과 다를 수 있다 (빌더 커스터마이즈, 인라인 추출 필수)', () => {
  // 좀도둑 embedded gold=80·flags=0112, 템플릿 123과 다름 → 템플릿 재구성 불가.
  const r = room135();
  assert.equal(r.monsters[0].gold, 80);
  assert.equal(r.monsters[0].flags, '0112000000000000');
});

'use strict';
/*
 * convertWorld 번들·meta·멱등성·orphan 제외 테스트 (node:test).
 * 실제 legacy/muhan → 스크래치 디렉토리 2회 변환.
 */
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { convert } = require('./convertWorld.js');

const ROOT = path.join(__dirname, '../../legacy/muhan');

let dirA, dirB, statA;

before(() => {
  dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'muhan-convA-'));
  dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'muhan-convB-'));
  statA = convert(ROOT, dirA, false);
  convert(ROOT, dirB, false);
});

test('rooms.json 번들 + meta.json을 emit한다', () => {
  assert.ok(fs.existsSync(path.join(dirA, 'rooms.json')));
  assert.ok(fs.existsSync(path.join(dirA, 'meta.json')));
});

test('번들 방은 신규 스폰 필드를 담는다 (방 135)', () => {
  const bundle = JSON.parse(fs.readFileSync(path.join(dirA, 'rooms.json')));
  const r135 = bundle.find((r) => r.id === 135);
  assert.ok(r135, '방 135가 번들에 있어야 한다');
  assert.equal(r135.traffic, 10);
  assert.deepEqual(r135.random, [13, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(r135.perm_mon[0], { interval: 100, ltime: 871640363, misc: 123 });
  assert.deepEqual(r135.perm_mon[1], { interval: 100, ltime: 871640364, misc: 123 });
});

test('번들은 id 오름차순 정렬', () => {
  const bundle = JSON.parse(fs.readFileSync(path.join(dirA, 'rooms.json')));
  for (let i = 1; i < bundle.length; i++) {
    assert.ok(bundle[i].id > bundle[i - 1].id, `id 정렬 위반 @${i}`);
  }
});

test('orphan 제외 유지 — counts.rooms=2341', () => {
  const meta = JSON.parse(fs.readFileSync(path.join(dirA, 'meta.json')));
  assert.equal(meta.counts.rooms, 2341);
});

test('creatures.json 엔트리가 numwander를 담는다 (D9)', () => {
  const crts = JSON.parse(fs.readFileSync(path.join(dirA, 'creatures.json')));
  const byId = new Map(crts.map((c) => [c.id, c]));
  // numwander(CRT offset 322, int16LE)는 random 스폰 그룹 크기 입력.
  assert.equal(byId.get(25).numwander, 3);
  assert.equal(byId.get(3).numwander, 2);
  assert.equal(byId.get(0).numwander, 1);
});

test('임베디드 몬스터도 numwander를 담는다 (rooms.json 번들)', () => {
  const bundle = JSON.parse(fs.readFileSync(path.join(dirA, 'rooms.json')));
  const r135 = bundle.find((r) => r.id === 135);
  assert.ok(r135.monsters.length > 0);
  for (const m of r135.monsters) {
    assert.equal(typeof m.numwander, 'number');
  }
});

test('meta counts는 실측 (objects=709, creatures=674)', () => {
  const meta = JSON.parse(fs.readFileSync(path.join(dirA, 'meta.json')));
  assert.equal(meta.counts.objects, 709);
  assert.equal(meta.counts.creatures, 674);
  assert.equal(meta.counts.rooms, statA.rooms);
});

test('멱등 — 2회 변환 산출물 바이트 동일', () => {
  for (const f of ['rooms.json', 'meta.json', 'objects.json', 'creatures.json']) {
    const a = fs.readFileSync(path.join(dirA, f));
    const b = fs.readFileSync(path.join(dirB, f));
    assert.ok(a.equals(b), `${f} 멱등 위반`);
  }
});

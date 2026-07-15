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

const FIXTURE = path.join(__dirname, '../../legacy/muhan/rooms/r00/r00135');

function room135() {
  return parseRoom(fs.readFileSync(FIXTURE));
}

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

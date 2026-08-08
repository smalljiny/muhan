'use strict';
/*
 * templates.js 별칭 키(`char key[3][20]`) 추출 테스트 (node:test).
 *
 * 오라클 (legacy/muhan/src/mstruct.h 직접 확인):
 *   struct object   : name[80]@0, description[80]@80, key[3][20]@160, use_output[80]@220
 *                     → key 총 60B, 패딩 없음 (160+60 === 220).
 *   struct creature : name[80]@0, description[80]@80, talk[80]@160, password[15]@240,
 *                     key[3][20]@255, fd(short)@316
 *                     → key 총 60B + short 정렬 패딩 1B (255+60+1 === 316).
 *
 * 합성 버퍼는 EUC-KR 바이트를 hex 리터럴로 직접 심는다(인코딩 독립).
 *   b0c5b9cc = '거미', 2020...2020 = 앞뒤 공백, a1 단독 = EUC-KR 디코드 불가 → U+FFFD.
 *
 * 실데이터 픽스처 근거 (legacy/muhan/objmon, /^([om])(\d\d)$/ 파일만 — marbled_plaquard·
 * moon_scroll 등 비템플릿 파일이 셸 글로브 m·o 접두에 걸리므로 정규식 필터 필수).
 * 집계 단위: name이 비지 않은 엔트리를 대상으로 한 **key 슬롯 단위** 카운트다
 * (엔트리 단위로 세면 수치가 달라진다 — 하한선 단정이므로 어느 쪽이든 안전).
 *   name 비지 않은 엔트리 = 몬스터 674 / 아이템 709 (convertWorld.test.js meta lock과 동일)
 *   비어있지 않은 raw 키 슬롯 2284개 중 — 공백 전용 70개, 앞뒤 패딩 5개.
 *     → "trim 결과 빈 문자열 0건" 단정은 이 70개를 리더가 실제로 걸러냄을 증명한다(무의미한 항등식 아님).
 *   name이 해당 key로 시작하지 않는 진짜 별칭 슬롯 = 몬스터 422 / 아이템 595 (하한선으로 단정).
 *   U+FFFD 포함 key = m00 인덱스 87 ('동굴 탐험가')의 raw key[1] 정확히 1건 → D3 보존 정책 증거.
 *     readKeys는 빈 슬롯을 드롭하므로 결과 배열 인덱스와 raw 슬롯 번호는 일반적으로 다르다.
 *     아래 단정은 슬롯 번호에 의존하지 않고 값 자체로 보존을 증명한다.
 */
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { readKeys, readObject, readCreature, SZ, OBJ, CRT } = require('./templates.js');

const OBJMON = path.join(__dirname, '../../legacy/muhan/objmon');

// 3슬롯(각 20B) 키 블록 합성. slotHexes[i]는 슬롯 i 선두에 복사되고 나머지는 NUL.
// tailHex는 61번째 바이트(오프셋 60)부터 심어 over-read를 검출한다.
function keyBlock(slotHexes, tailHex = '') {
  const b = Buffer.alloc(60 + tailHex.length / 2);
  slotHexes.forEach((h, i) => Buffer.from(h, 'hex').copy(b, i * 20));
  if (tailHex) Buffer.from(tailHex, 'hex').copy(b, 60);
  return b;
}

// --- 합성 버퍼: 위생 규칙 ---

test('공백 전용 슬롯은 결과 배열에서 제외된다', () => {
  //  슬롯0=' ' 슬롯1='   ' 슬롯2='거미'
  const b = keyBlock(['20', '202020', 'b0c5b9cc']);
  assert.deepEqual(readKeys(b, 0), ['거미']);
});

// 선행 공백이 남으면 Story 5의 순수 접두 매칭이 불가능해진다.
test('앞뒤 패딩 슬롯은 trim된 값으로 보관된다 (raw 아님 — 접두 매처 입력)', () => {
  const b = keyBlock(['2020b0c5b9cc2020']); // '  거미  '
  assert.deepEqual(readKeys(b, 0), ['거미']);
});

// 슬롯1 첫 바이트 'B'가 슬롯0 값에 섞이면 20B 필드 경계를 넘어 읽은 것이다.
test('NUL 없이 20B를 채운 슬롯은 필드 길이에서 절단되고 21번째 바이트를 포함하지 않는다', () => {
  const b = keyBlock(['41'.repeat(20), '42']); // 슬롯0='A'×20 (NUL 없음), 슬롯1='B'
  assert.deepEqual(readKeys(b, 0), ['A'.repeat(20), 'B']);
});

test('키 블록은 60B를 넘어 읽지 않는다 (오프셋 60의 꼬리 바이트 미흡수)', () => {
  const filler = '41'.repeat(20);
  const b = keyBlock([filler, filler, filler], '5a5a5a'); // 꼬리 'ZZZ'
  const keys = readKeys(b, 0);
  assert.deepEqual(keys, ['A'.repeat(20), 'A'.repeat(20), 'A'.repeat(20)]);
  for (const k of keys) assert.ok(!k.includes('Z'), 'key[3][20] 60B 경계 over-read');
});

test('EUC-KR 디코드 불가 바이트는 U+FFFD를 포함한 채 보존된다 (D3: 정규화·치환 금지)', () => {
  const b = keyBlock(['b0c5b9cca1']); // '거미' + 단독 0xa1 → U+FFFD
  const keys = readKeys(b, 0);
  assert.ok(keys[0].includes('\uFFFD'), 'U+FFFD 제거·치환 로직이 들어가면 이 단정이 깨진다');
  assert.equal(keys[0], '거미\uFFFD');
});

// assert/strict의 deepEqual은 deepStrictEqual이라 배열 타입까지 함께 강제한다.
test('3슬롯이 모두 비면 빈 배열이다 (undefined 아님)', () => {
  assert.deepEqual(readKeys(keyBlock([]), 0), []);
});

test('readKeys는 절대 오프셋 start를 기준으로 읽는다', () => {
  const b = Buffer.alloc(200);
  keyBlock(['b0c5b9cc']).copy(b, 100);
  assert.deepEqual(readKeys(b, 100), ['거미']);
  assert.deepEqual(readKeys(b, 0), []);
});

// --- 합성 버퍼: 리더 배선 ---

test('readObject가 OBJ.key(160)에서 keys를 추출하고 description 뒤에 둔다', () => {
  const b = Buffer.alloc(SZ.object);
  Buffer.from('b5bfb1bc', 'hex').copy(b, OBJ.name); // name='동굴'
  keyBlock(['b0c5b9cc', '2020b0c5b9cc2020', '20']).copy(b, OBJ.key);
  const o = readObject(b);
  assert.deepEqual(o.keys, ['거미', '거미']);
  const order = Object.keys(o);
  assert.equal(order[order.indexOf('description') + 1], 'keys', 'C struct 순서: description 뒤');
});

test('readObject는 base 상대 오프셋으로 동작한다 (평면 배열 인덱스)', () => {
  const b = Buffer.alloc(SZ.object * 2);
  keyBlock(['b0c5b9cc']).copy(b, SZ.object + OBJ.key);
  assert.deepEqual(readObject(b, 0).keys, []);
  assert.deepEqual(readObject(b, SZ.object).keys, ['거미']);
});

test('readCreature가 CRT.key(255)에서 keys를 추출하고 talk 뒤에 둔다', () => {
  const b = Buffer.alloc(SZ.creature);
  Buffer.from('b5bfb1bc', 'hex').copy(b, CRT.name);
  keyBlock(['b0c5b9cc', '20', 'b5bfb1bc']).copy(b, CRT.key);
  const c = readCreature(b);
  assert.deepEqual(c.keys, ['거미', '동굴']);
  const order = Object.keys(c);
  assert.equal(order[order.indexOf('talk') + 1], 'keys', 'C struct 순서: talk 뒤');
});

test('readCreature는 base 상대 오프셋으로 동작한다', () => {
  const b = Buffer.alloc(SZ.creature * 2);
  keyBlock(['b5bfb1bc']).copy(b, SZ.creature + CRT.key);
  assert.deepEqual(readCreature(b, 0).keys, []);
  assert.deepEqual(readCreature(b, SZ.creature).keys, ['동굴']);
});

// --- 오프셋 lock (헤더 없이 key[3][20] 총 60B와 over-read 부재를 증명) ---

test('OBJ.key 오프셋은 오라클 160', () => {
  assert.equal(OBJ.key, 160);
});

test('CRT.key 오프셋은 오라클 255', () => {
  assert.equal(CRT.key, 255);
});

test('object의 key[3][20]은 60B이고 use_output(220)과 맞닿는다 (패딩 없음)', () => {
  assert.equal(OBJ.key + 60, OBJ.use_output);
  assert.equal(OBJ.use_output, 220);
});

test('creature의 key[3][20]은 60B이고 fd(316) 앞 정렬 패딩 1B를 남긴다', () => {
  assert.equal(CRT.key + 60 + 1, CRT.fd);
  assert.equal(CRT.fd, 316);
});

// --- 실데이터 스캔 (legacy/muhan/objmon) ---

// convertWorld.js:50과 동일한 정규식 필터. m*/o* 글로브는 비템플릿 파일을 흡수한다.
function scanTemplates() {
  const stat = {
    m: { entries: 0, unsanitized: 0, aliases: 0, nonArray: 0 },
    o: { entries: 0, unsanitized: 0, aliases: 0, nonArray: 0 },
    fffd: [],
  };
  for (const f of fs.readdirSync(OBJMON).sort()) {
    const m = /^([om])(\d\d)$/.exec(f);
    if (!m) continue;
    const kind = m[1];
    const sz = kind === 'o' ? SZ.object : SZ.creature;
    const buf = fs.readFileSync(path.join(OBJMON, f));
    const n = Math.floor(buf.length / sz);
    for (let i = 0; i < n; i++) {
      const base = i * sz;
      const e = kind === 'o' ? readObject(buf, base) : readCreature(buf, base);
      if (!e.name) continue; // convertWorld와 동일한 "빈 슬롯" 판정
      stat[kind].entries++;
      // 픽스처 빌더는 단정하지 않는다 — 위반 건수를 모아 전용 테스트가 판정한다.
      if (!Array.isArray(e.keys)) { stat[kind].nonArray++; continue; }
      // 결과 배열 인덱스는 raw 슬롯 번호가 아니다(헤더 주석) — 슬롯 번호를 기록하지 않는다.
      e.keys.forEach((k) => {
        // 위생 계약 전체를 검사한다 — 빈 문자열뿐 아니라 미trim 값도 위반이다.
        if (k === '' || k.trim() !== k) stat[kind].unsanitized++;
        if (!e.name.startsWith(k)) stat[kind].aliases++;
        if (k.includes('\uFFFD')) stat.fffd.push({ file: f, index: i, name: e.name, value: k });
      });
    }
  }
  return stat;
}

// 전 objmon 파일을 1회만 훑는다 (convertWorld.test.js의 before() 관례와 동일).
let s;
before(() => { s = scanTemplates(); });

test('실데이터: name 비지 않은 엔트리 수 (몬스터 674·아이템 709 실측, 하한선 단정)', () => {
  assert.ok(s.m.entries >= 674, `몬스터 엔트리 ${s.m.entries} < 674`);
  assert.ok(s.o.entries >= 709, `아이템 엔트리 ${s.o.entries} < 709`);
});

test('실데이터: 전 엔트리의 keys가 배열이다 (undefined·비배열 0건)', () => {
  assert.equal(s.m.nonArray, 0);
  assert.equal(s.o.nonArray, 0);
});

test('실데이터: 위생 계약 위반(빈 문자열·미trim) 0건 (공백 전용 raw 슬롯 70개 필터 증명)', () => {
  assert.equal(s.m.unsanitized, 0);
  assert.equal(s.o.unsanitized, 0);
});

test('실데이터: 몬스터의 진짜 별칭(name이 key로 시작하지 않음) 300건 이상 (실측 422)', () => {
  assert.ok(s.m.aliases >= 300, `진짜 별칭 ${s.m.aliases} < 300`);
});

test('실데이터: 아이템의 진짜 별칭 400건 이상 (실측 595)', () => {
  assert.ok(s.o.aliases >= 400, `진짜 별칭 ${s.o.aliases} < 400`);
});

test('실데이터: U+FFFD 포함 key는 m00[87] 1건뿐이며 보존된다 (D3)', () => {
  assert.equal(s.fffd.length, 1);
  assert.deepEqual(s.fffd[0], {
    file: 'm00',
    index: 87,
    name: '동굴 탐험가',
    // EUC-KR a4c5 bdc7 e8b0 a1 → 'ㅕ실瘟' + 미완결 a1
    value: '\u3155\uC2E4\u761F\uFFFD',
  });
});

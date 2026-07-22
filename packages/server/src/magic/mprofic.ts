import { MAGE, CLERIC, PALADIN, RANGER, INVINCIBLE, CARETAKER, SUB_DM, DM } from '../combat/constants.js'

/**
 * mprofic — realm별 원시 누적경험치(realm[])를 0-110 숙련 백분율로 환산한다(player.c:1204-1261 byte 정본).
 *
 * 클래스마다 12칸 임계 테이블(prof_array)이 다르며, n=realm[index-1]이 어느 임계 구간에 드는지로 십분위
 * 숙련(10*i)을 정하고 구간 내 선형 보간을 분수항으로 더한다. 모든 나눗셈은 C 정수 나눗셈=Math.trunc다
 * (float 드리프트가 데미지 bns를 어긋나게 하므로).
 *
 * ## read-only (성장 write 금지)
 * realm[]은 **읽기만** 한다 — realm 성장(addrealm, magic1.c:1124 `ply_ptr->realm[...] += addrealm`)은
 * #85 소관이라 이 포트에서 절대 write하지 않는다. 전 몬스터 realm=0이라 #84 라이브 입력은 항상 prof=0이다.
 *
 * ## OOB port 결정 (byte-충실 아닌 정의된 동작)
 * 오라클은 n>=prof_array[11](5억)이면 for가 break 없이 종료해 `prof` 미초기화 + prof_array[12] OOB 읽기(C UB)다.
 * realm=0이라 #84 라이브 도달은 불가하나, 정의된 동작으로 **prof=110 clamp**한다.
 */

// prof_array 클래스별 12칸 임계 테이블 — player.c:1215-1258 독립 전사.
const PROF_MAGE = [0, 1024, 2048, 4096, 8192, 16384, 35768, 85536, 140000, 459410, 2073306, 500000000]
const PROF_CLERIC = [0, 1024, 4092, 8192, 16384, 32768, 70536, 119000, 226410, 709410, 2973307, 500000000]
const PROF_PALADIN = [0, 1024, 8192, 16384, 32768, 65536, 105000, 165410, 287306, 809410, 3538232, 500000000]
const PROF_DEFAULT = [0, 1024, 40000, 80000, 120000, 160000, 205000, 222000, 380000, 965410, 5495000, 500000000]

/** 클래스 → 숙련 임계 테이블(player.c:1211-1259 switch). MAGE 계열·CLERIC·PALADIN 계열·그 외 default. */
function profArray(cls: number): readonly number[] {
  switch (cls) {
    case MAGE:
    case INVINCIBLE:
    case CARETAKER:
    case SUB_DM:
    case DM:
      return PROF_MAGE
    case CLERIC:
      return PROF_CLERIC
    case PALADIN:
    case RANGER:
      return PROF_PALADIN
    default:
      return PROF_DEFAULT
  }
}

/**
 * mprofic(class, realm[], index) → 0-110 숙련 백분율. index는 realm 번호(1-4, EARTH=1…WATER=4)이며
 * realm[index-1]을 조회한다. offensiveSpell이 `mprofic(caster.class, caster.realm, osp.realm)`로 소비한다.
 */
export function mprofic(cls: number, realm: readonly number[], index: number): number {
  const profTable = profArray(cls)
  const n = realm[index - 1] ?? 0

  // 임계 구간 탐색 — 엄격 <로 십분위 구간을 정한다(경계값은 다음 구간 하한에 안착).
  // 첫 구간에서 선형 보간을 계산·break한다. break가 없으면(n>=5억) OOB port 결정으로 110 clamp.
  for (let i = 0; i < 11; i += 1) {
    const hi = profTable[i + 1]
    if (hi !== undefined && n < hi) {
      const lo = profTable[i] ?? 0
      // 구간 내 선형 보간 — Math.trunc(C 정수 나눗셈). prof = 10*i + trunc((n - lo)*10 / (hi - lo)).
      return 10 * i + Math.trunc(((n - lo) * 10) / (hi - lo))
    }
  }
  // OOB port 결정: break 없이 종료(n>=5억)면 110 clamp(위 주석 UB 참조).
  return 110
}

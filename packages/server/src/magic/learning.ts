import { isKnown, setKnown, spellByNo } from 'shared'
import { CLERIC, MAGE, INVINCIBLE, CARETAKER, SUB_DM } from '../combat/constants.js'
import { F_ISSET, PBLIND, PSILNC, OGOODO, OEVILO, OCLSEL } from '../world/hexFlags.js'
import { SCROLL } from '../items/taxonomy.js'

/**
 * 주문 학습·전수 순수 함수(#85 G2, A6 §8) — study(비법서 연마)·teach(전수).
 *
 * ## 범위 경계 — 순수 함수 + seam(라이브 라우팅 #106)
 * study/teach는 게이트를 평가하고 통과 시 spell store 비트를 set한 **새 store를 반환**한다. 입력
 * char/caster/target·book을 변형하지 않는다(immutability). 라이브 command 라우팅(cast/study/teach)·
 * 비법서 소멸(free_obj)·정렬실패 시 방 낙하·전수 broadcast 메시지는 배선 계층(#106) 소관이다 — 이
 * 모듈은 지식 획득 규칙만 이식한다.
 *
 * ## Caster 계약을 쓰지 않는 이유
 * study/teach 게이트는 PBLIND/PSILNC(flags)·alignment를 읽는데, 이는 #84 Caster 6필드 계약에 없다
 * (Caster는 시전 hot-path 전용). 학습은 별개 경로이므로 PlayerCombatState가 만족하는 좁은 구조적
 * 입력 타입(StudyChar·TeachCaster·TeachTarget)을 정의한다 — Caster 계약을 확장하지 않는다.
 *
 * ## spllv 테이블은 여기(server) — mprofic 선례
 * spllv 전수등급 판정은 server 클래스 상수(combat/constants.ts)를 소비하므로 shared spellStore.ts가
 * 아닌 여기에 둔다. shared는 server를 import 못 하고, shared에 클래스 상수를 새로 만들면 발명 금지에
 * 걸린다 — mprofic(server 소유 + shared fixture + server approve)과 동형 배치다.
 */

// ── T3.1: spllv 전수등급 테이블 ──────────────────────────────────────────────

/**
 * spllv 전수 권한 — magic1.c:212-235 spllv 5-if 체인. 각 if는 성립 시 전수 거부(return 0)이며,
 * 여기서는 그 부정(전수 가능)을 반환한다. 클래스 상수는 combat/constants.ts를 재사용한다.
 *
 * spllv 1: class==CLERIC || class>=INVINCIBLE
 * spllv 2: class==MAGE   || class>=INVINCIBLE
 * spllv 3: class>=INVINCIBLE
 * spllv 4: class>=CARETAKER
 * spllv 5: class>=SUB_DM
 * spllv 1-5 밖이면 매칭 if가 없어 거부 미발화 → true(magic1.c 충실).
 *
 * 이 함수는 spllv 체크만 담당한다 — teach base-class 게이트(CARETAKER/MAGE/CLERIC)는 teach()가 조합한다.
 */
export function canTeachSpllv(casterClass: number, spllv: number): boolean {
  if (spllv === 1) return casterClass === CLERIC || casterClass >= INVINCIBLE
  if (spllv === 2) return casterClass === MAGE || casterClass >= INVINCIBLE
  if (spllv === 3) return casterClass >= INVINCIBLE
  if (spllv === 4) return casterClass >= CARETAKER
  if (spllv === 5) return casterClass >= SUB_DM
  return true
}

// ── T3.2: study(비법서 연마) ─────────────────────────────────────────────────

/** 비법서(SCROLL) 오브젝트 템플릿의 study 관련 필드 — magicpower=주문번호+1, ndice=레벨제한. */
export interface SpellBook {
  /** object 타입 — SCROLL(7)만 연마 가능(magic1.c:294). */
  readonly type: number
  /** 레벨 제한 — level < ndice이면 연마 실패(magic1.c:300). */
  readonly ndice: number
  /** 담긴 주문번호+1 — 성공 시 S_SET(magicpower-1)(magic1.c:336). */
  readonly magicpower: number
  /** object flags(hex string) — OGOODO/OEVILO(정렬)·OCLSEL(클래스) 게이트. */
  readonly flags: string
}

/** study 입력 char — PlayerCombatState가 구조적으로 만족한다(레벨·클래스·정렬·지식·상태 플래그). */
export interface StudyChar {
  readonly level: number
  readonly class: number
  readonly alignment: number
  readonly spells: readonly number[]
  readonly flags: string
}

/** study 실패 사유(exhaustive) — 통과면 null. */
export type StudyFailure = 'blind' | 'not-a-book' | 'level' | 'alignment' | 'class' | 'no-spell'

/**
 * study 결과. 성공(ok=true)이면 spells는 magicpower-1 비트를 set한 새 store, 실패면 char.spells 불변.
 */
export interface StudyResult {
  readonly ok: boolean
  readonly failure: StudyFailure | null
  readonly spells: readonly number[]
}

/**
 * 비법서를 연마해 주문을 영구 학습한다(magic1.c:259 study). 게이트를 순서대로 평가하고 첫 실패에서
 * 접는다: PBLIND → SCROLL 여부 → 레벨(ndice>level) → 정렬(OGOODO/OEVILO) → 클래스(OCLSEL). 통과 시
 * setKnown(magicpower-1)한 새 store를 반환한다. 입력 char/book을 변형하지 않는다(순수).
 */
export function study(char: StudyChar, book: SpellBook): StudyResult {
  const unchanged = (failure: StudyFailure): StudyResult => ({ ok: false, failure, spells: char.spells })

  // ① PBLIND — 실명이면 비법서를 연마할 수 없다(magic1.c:270).
  if (F_ISSET(char.flags, PBLIND)) return unchanged('blind')

  // ② SCROLL 여부 — 비법서가 아니면 연마 불가(magic1.c:294).
  if (book.type !== SCROLL) return unchanged('not-a-book')

  // ③ 레벨 제한 — book.ndice > level이면 내용을 파악 못 해 실패(magic1.c:300).
  if (book.ndice > char.level) return unchanged('level')

  // ④ 정렬 — OGOODO인데 alignment<-100, 또는 OEVILO인데 alignment>100이면 실패(magic1.c:305).
  //    원작은 이때 비법서를 방에 떨어뜨리지만, 그 소멸/이동은 배선 계층 소관(store만 불변 반환).
  if (
    (F_ISSET(book.flags, OGOODO) && char.alignment < -100) ||
    (F_ISSET(book.flags, OEVILO) && char.alignment > 100)
  ) {
    return unchanged('alignment')
  }

  // ⑤ 클래스 — OCLSEL이 켜져 있고 OCLSEL+class 비트가 없으며 class<CARETAKER면 직업상 연마 불가
  //    (magic1.c:312). CARETAKER↑는 클래스 게이트를 우회한다.
  if (
    F_ISSET(book.flags, OCLSEL) &&
    !F_ISSET(book.flags, OCLSEL + char.class) &&
    char.class < CARETAKER
  ) {
    return unchanged('class')
  }

  // ⑥ magicpower<1이면 담긴 주문이 없어(splno=-1) 세팅 불가 — 음수 인덱스 write 차단(consume.ts 선례).
  if (book.magicpower < 1) return unchanged('no-spell')

  // 통과 — S_SET(magicpower-1)한 새 store 반환.
  return { ok: true, failure: null, spells: setKnown(char.spells, book.magicpower - 1) }
}

// ── T3.3: teach(전수) ────────────────────────────────────────────────────────

/** teach 시전자 — 전수 자격(클래스·상태 플래그)과 자신의 지식을 판정할 필드. */
export interface TeachCaster {
  readonly class: number
  readonly spells: readonly number[]
  readonly flags: string
}

/** teach 대상 — 전수받을 spell store만 필요하다. */
export interface TeachTarget {
  readonly spells: readonly number[]
}

/** teach 실패 사유(exhaustive) — 통과면 null. */
export type TeachFailure = 'blind' | 'silence' | 'class' | 'unknown-spell' | 'knowledge' | 'spllv'

/**
 * teach 결과. 성공(ok=true)이면 spells는 spellNo 비트를 set한 새 target store, 실패면 target.spells 불변.
 */
export interface TeachResult {
  readonly ok: boolean
  readonly failure: TeachFailure | null
  readonly spells: readonly number[]
}

/**
 * 대상에게 주문을 전수한다(magic1.c:125 teach). 게이트 순서: PBLIND → PSILNC → base-class
 * (CARETAKER/MAGE/CLERIC) → 주문 존재 → 시전자 지식(S_ISSET) → spllv 전수등급. 통과 시 target store에
 * setKnown(spellNo)한 새 store를 반환한다. 입력 caster/target을 변형하지 않는다(순수).
 *
 * ⚠️ base-class 게이트는 CARETAKER(10)/MAGE(5)/CLERIC(3)만 통과시킨다 — INVINCIBLE(9)·SUB_DM(11)·
 * DM(12)은 전수 불가다(magic1.c:152 원작 충실). 그 결과 spllv 5 주문은 실질 전수 불가 quirk가 된다.
 */
export function teach(caster: TeachCaster, target: TeachTarget, spellNo: number): TeachResult {
  const unchanged = (failure: TeachFailure): TeachResult => ({
    ok: false,
    failure,
    spells: target.spells,
  })

  // ① PBLIND — 실명이면 전수 불가(magic1.c:140).
  if (F_ISSET(caster.flags, PBLIND)) return unchanged('blind')

  // ② PSILNC — 침묵이면 전수 불가(magic1.c:145).
  if (F_ISSET(caster.flags, PSILNC)) return unchanged('silence')

  // ③ base-class — CARETAKER/MAGE/CLERIC만 전수 능력을 가진다(magic1.c:152).
  if (caster.class !== CARETAKER && caster.class !== MAGE && caster.class !== CLERIC) {
    return unchanged('class')
  }

  // ④ 주문 존재 — 카탈로그에 없는 주문번호는 전수 불가(magic1.c match==0).
  const entry = spellByNo(spellNo)
  if (entry === undefined) return unchanged('unknown-spell')

  // ⑤ 시전자 지식 — 시전자가 그 주문을 터득해야 전수 가능(magic1.c:190 S_ISSET).
  if (!isKnown(caster.spells, spellNo)) return unchanged('knowledge')

  // ⑥ spllv 전수등급 — 클래스가 주문 spllv 등급을 전수할 권한이 있어야 한다(magic1.c:212-235).
  if (!canTeachSpllv(caster.class, entry.spllv)) return unchanged('spllv')

  // 통과 — target store에 S_SET(spellNo)한 새 store 반환.
  return { ok: true, failure: null, spells: setKnown(target.spells, spellNo) }
}

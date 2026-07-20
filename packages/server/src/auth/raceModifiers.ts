/**
 * 종족 스탯 보정 — 캐릭터 생성의 마지막 단계에서 포인트바이 스탯에 더하는 순수 테이블·헬퍼.
 *
 * a7 오라클 §7(command1.c:338~)의 8종족 생성 시 스탯 보정을 [힘,민첩,맷집,지식,신앙심] 순서로
 * 이식한다 — 이 순서는 characterSchema.stats 튜플 순서와 동일하다. 종족 코드(1~8)는 오라클 RACE 상수다.
 *
 * server E5 코드에 둔다(shared/stats가 아니라) — #80 stats-core의 병합 표면과 분리한다. DTO가 raw
 * 포인트바이 스탯 + 종족 코드를 나르고, Character 문서를 조립하는 지점(firebase 어댑터 createCharacter)에서
 * 이 헬퍼로 저장할 최종 스탯을 만든다.
 */

/** 종족 코드(1~8) → [힘,민첩,맷집,지식,신앙심] 보정 튜플. a7 §7 오라클 표. */
export const RACE_STAT_MODIFIERS: Record<
  number,
  readonly [number, number, number, number, number]
> = {
  1: [1, 0, 0, 0, -1], // DWARF 난장이족 — 힘+1 신앙-1
  2: [-1, 0, -1, 2, 0], // ELF 용신족 — 지식+2 맷집-1 힘-1
  3: [0, 0, -1, 1, 0], // HALFELF 요괴족 — 지식+1 맷집-1
  4: [-1, 1, 0, 0, 0], // HOBBIT 토신족 — 민첩+1 힘-1
  5: [0, 0, 1, 0, 0], // HUMAN 인간족 — 맷집+1
  6: [1, -1, 1, -1, 0], // ORC 도깨비족 — 힘+1 맷집+1 민첩-1 지식-1
  7: [2, 0, 0, -1, -1], // HALFGIANT 거인족 — 힘+2 지식-1 신앙-1
  8: [-1, 0, 0, 0, 1], // GNOME 땅귀신족 — 신앙+1 힘-1
}

/**
 * 포인트바이 스탯에 종족 보정을 원소별로 더한다(포인트바이 검증 *후* 적용).
 *
 * 3~18 재클램프를 하지 않는다(as-shipped — 오라클 종족 보정은 상·하한을 재확인하지 않는다). 극단 배분 시
 * 유효 스탯이 18을 넘거나 3 미만이 될 수 있고 그대로 저장한다 — #80 stats-core의 bonus()가 read-time에
 * 클램프한다. 입력 튜플을 변형하지 않고 새 튜플을 반환한다(불변성). 알 수 없는 종족 코드는 보정 없이
 * 원본 복사본을 돌려준다(방어 — 정상 경로는 reducer가 종족을 1~8로 검증한 뒤 도달한다).
 */
export function applyRaceModifiers(
  stats: readonly [number, number, number, number, number],
  race: number,
): [number, number, number, number, number] {
  const mod = RACE_STAT_MODIFIERS[race]
  if (mod === undefined) {
    return [stats[0], stats[1], stats[2], stats[3], stats[4]]
  }
  return [
    stats[0] + mod[0],
    stats[1] + mod[1],
    stats[2] + mod[2],
    stats[3] + mod[3],
    stats[4] + mod[4],
  ]
}

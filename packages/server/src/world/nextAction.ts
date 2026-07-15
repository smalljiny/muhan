import type { CreatureInstance } from 'shared'

/**
 * next-action 스케줄링 헬퍼 — 크리처별 다음 행동 도래 시각(`nextActionAt`)을 세팅·판정한다(플랜 T3.1).
 *
 * 원본 update.c:280 LT_ATTCK 게이트 이식: 매 초 루프지만 개별 크리처 행동은 민첩 연동 2~3초 간격이다.
 * `nextActionAt`은 크리처에 붙은 개별 타이머(A9 아키텍처 함의 4 "몬스터별 next-action 시각")이므로
 * 별도 전역 힙·방 레지스트리를 두지 않는다 — 활성 방 집합(activeSet)이 "어떤 방이 도는지"의 단일
 * 출처이고, 이 헬퍼는 그 방들의 크리처 타이머만 다룬다(D3 방별 로컬 큐, activeSet과 정합).
 *
 * `scheduleNextAction`은 크리처의 `nextActionAt`을 in-place로 세팅한다(worldGraph 라이브 가변 필드
 * carve-out — gameTime 클로저 상태·문 상태와 동형). 그 외 순수 조회 함수는 입력을 변형하지 않는다.
 */

/** 공격 주기(초) — 민첩<20이면 3, 아니면 2(원본 update.c:280). */
export function cadenceSec(dexterity: number): number {
  return dexterity < 20 ? 3 : 2
}

/**
 * 크리처의 다음 행동 도래 시각을 `now + cadence(dex)`로 세팅한다(in-place carve-out).
 * autonomic 처리 직후 재스케줄, 활성 진입 시 초기화에 쓰인다.
 */
export function scheduleNextAction(creature: CreatureInstance, now: number): void {
  creature.nextActionAt = now + cadenceSec(creature.dexterity)
}

/**
 * 크리처가 이번 `now`에 행동할 차례인지. `nextActionAt` 미설정이면 도래로 취급한다 — 첫 활성 틱에
 * 아직 스케줄되지 않은 크리처를 즉시 처리·초기화 대상으로 삼는다(oracle §2.2 스폰 시 타이머 초기화).
 */
export function isDue(creature: CreatureInstance, now: number): boolean {
  return creature.nextActionAt === undefined || creature.nextActionAt <= now
}

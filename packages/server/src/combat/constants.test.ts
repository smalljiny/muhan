import { describe, it, expect } from 'vitest'
import {
  CRIT_MULTIPLIER_MIN,
  CRIT_MULTIPLIER_MAX,
  HIT_ROLL_MAX_PLAYER,
  HIT_ROLL_MAX_MONSTER,
  PVP_COOLDOWN_INCREMENT,
} from './constants.js'

/**
 * 전투 튜닝 상수 오라클 값 회귀 가드 — 스펙 §3.7 외부화 값이 byte-fidelity 소스와 일치하는지 고정한다.
 * 크리티컬 배수 `mrand(3,6)`, 명중 굴림 상한(플레이어 `mrand(1,30)`·몬스터 `mrand(1,20)`),
 * PvP 쿨다운 증분 `+3`. 후속 Story(5/6/8)가 이 값을 소비한다.
 */
describe('combat 튜닝 상수', () => {
  it('크리티컬 배수 범위는 mrand(3,6) → [3, 6]', () => {
    expect(CRIT_MULTIPLIER_MIN).toBe(3)
    expect(CRIT_MULTIPLIER_MAX).toBe(6)
  })

  it('명중 굴림 상한: 플레이어 30, 몬스터 20', () => {
    expect(HIT_ROLL_MAX_PLAYER).toBe(30)
    expect(HIT_ROLL_MAX_MONSTER).toBe(20)
  })

  it('PvP 쿨다운 증분은 +3', () => {
    expect(PVP_COOLDOWN_INCREMENT).toBe(3)
  })
})

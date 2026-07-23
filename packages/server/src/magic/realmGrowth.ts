/**
 * realmGrowth.ts — realm 숙련 성장량 공식 realmGrowthAmount(magic1.c:1122-1130, A6 §5).
 *
 * 공격 주문으로 **몬스터(비-PLAYER)**에게 피해를 주면 시전자의 realm 숙련 경험치가 준 피해 비율만큼
 * 자란다. 오라클(magic1.c:1122-1130):
 *
 * ```
 * m = MIN(crt_ptr->hpcur, dmg);                                  // 저항 後·차감 前 오버킬 캡
 * addrealm = (m * crt_ptr->experience) / MAX(1, crt_ptr->hpmax); // 정수 절삭
 * addrealm = MIN(addrealm, crt_ptr->experience);                 // 몬스터 exp 캡
 * if(crt_ptr->type != PLAYER) ply_ptr->realm[osp->realm-1] += addrealm;   // PvP는 성장 없음
 * ```
 *
 * ## combat exp 분배와 동형(A6 §5·§7) — delta만 반환(deathDistribution 선례 충실)
 * deathDistribution의 기여자 exp `expdiv = trunc(exp*dmg/MAX(hpmax,1))` 캡 exp와 **동일 base 공식**이다
 * (그룹킬 `+exp/10` 항은 realm 성장에 대응물이 없다 — base expdiv에만 동형). m=피해(기여), exp=몬스터
 * experience, hpmax=몬스터 최대 hp. deathDistribution이 exp delta(number)만 반환하듯 이 함수도 성장량
 * 스칼라만 반환한다 — PvE 가드(`crt->type != PLAYER`)는 호출자(offensiveSpell hook), realm 슬롯 적용
 * (`realm[osp.realm-1] += growth`)·영속 write는 #99 라이브 조립(markDirty seam, OpenQ #2) 소관이다.
 *
 * @param m     준 피해(저항 後·오버킬 캡, offensiveSpell의 m=MIN(hpBefore,dmg)).
 * @param exp   대상 몬스터 experience(성장 상한 겸 비례 상수).
 * @param hpmax 대상 몬스터 최대 hp(분모, MAX(1,hpmax) 0가드).
 * @returns     이번 피해로 얻는 realm 숙련 경험치 성장량.
 */
export function realmGrowthAmount(m: number, exp: number, hpmax: number): number {
  return Math.min(Math.trunc((m * exp) / Math.max(1, hpmax)), exp)
}

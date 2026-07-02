import { z } from 'zod'

/** 방 출구의 문 상태 — 닫힘/잠김 여부. */
export const exitStateSchema = z.strictObject({
  // 출구 방향(한글 방향명 또는 별칭).
  direction: z.string().min(1),
  closed: z.boolean(),
  locked: z.boolean(),
})

/** 몬스터 리스폰 타이머 상태. */
export const respawnStateSchema = z.strictObject({
  // 리스폰 간격(초/틱 의미).
  interval: z.int().min(0),
  // 마지막 사망 시각(에포크/틱). 미사망 시 0.
  lastDeathTime: z.int().min(0),
  // 리스폰 대상 몬스터 템플릿 참조.
  mobId: z.int(),
})

/**
 * 방 런타임 상태 영속 문서.
 *
 * roomId(방 번호)가 안정적 자연키이므로 별도 합성 _id를 두지 않는다.
 */
export const roomStateSchema = z.strictObject({
  roomId: z.int().min(0),
  exits: z.array(exitStateSchema),
  respawn: z.array(respawnStateSchema),
  schemaVersion: z.int(),
})

export type ExitState = z.infer<typeof exitStateSchema>
export type RespawnState = z.infer<typeof respawnStateSchema>
export type RoomState = z.infer<typeof roomStateSchema>

import { z } from 'zod'

/**
 * 세션 계열 계약 building block — 캐릭터 선택·생성 다단 대화의 와이어 전용 단일 출처.
 *
 * events.ts가 session:prompt·session:characterList variant에서 이 스키마들을 재사용한다.
 * import 방향은 events → session 단방향이며(session은 events를 import하지 않는다) 순환이 없다.
 * 영속 스키마(schema/character.ts)와 독립한 와이어 전용 신설이다 — Pick/파생하지 않는다.
 */

/** prompt 종류 — 캐릭터 선택 단계와 생성 필드 입력 단계(확인 단계도 createField로 처리). */
export const promptKindSchema = z.enum(['selectCharacter', 'createField'])

/** prompt 선택지 원소 — value는 session:reply.value(문자열)와 정합하는 기계값, label은 사람용 표시. */
export const promptOptionSchema = z.strictObject({
  value: z.string().min(1),
  label: z.string().min(1),
})

/**
 * 캐릭터 요약 DTO — 캐릭터 선택 화면이 싣는 와이어 전용 요약.
 *
 * 영속 스키마의 _id 대신 와이어 이름 characterId를 쓰고, persistence엔 없는 level을 포함한다.
 * class·race는 정수 코드다.
 */
export const characterSummarySchema = z.strictObject({
  characterId: z.string().min(1),
  name: z.string().min(1),
  class: z.int(),
  race: z.int(),
  level: z.int(),
})

export type PromptKind = z.infer<typeof promptKindSchema>
export type PromptOption = z.infer<typeof promptOptionSchema>
export type CharacterSummary = z.infer<typeof characterSummarySchema>

import { loadWorldFile } from 'shared'

/**
 * object 템플릿 인덱스 — 아이템 번호(objnum)로 스탯 템플릿을 조회하는 seam.
 *
 * world/spawn.ts의 `SpawnTemplateIndex`·`buildSpawnTemplateIndex`·`loadSpawnTemplates` 관례를
 * 그대로 미러링한다. objects.json raw 엔트리에서 템플릿 스탯만 복사해 raw 번들과 분리하고,
 * objnum 키의 `ReadonlyMap`으로 담는다.
 *
 * 인스턴스 런타임값 `shotscur`는 제외한다(objectSchema.shotscur가 소유). `description`도 템플릿
 * 스탯이 아니라 제외한다. `flags`는 hex 문자열 비트필드로 그대로 보존한다(flags.ts predicate가 파싱).
 */

/** objectSchema type cap(0~14) — 이보다 큰 type은 게시판 엔트리(100~120)로 인덱스에서 제외한다. */
const MAX_OBJECT_TYPE = 14

/** object 템플릿 = 아이템 스탯 서브셋(인스턴스 런타임값 shotscur·description 제외). */
export interface ObjectTemplate {
  readonly objnum: number
  readonly name: string
  readonly type: number
  readonly value: number
  readonly weight: number
  readonly adjustment: number
  readonly shotsmax: number
  readonly ndice: number
  readonly sdice: number
  readonly pdice: number
  readonly armor: number
  readonly wearflag: number
  readonly magicpower: number
  readonly magicrealm: number
  readonly special: number
  readonly questnum: number
  readonly flags: string
}

/** objnum → object 템플릿 인덱스. */
export type ObjectTemplateIndex = ReadonlyMap<number, ObjectTemplate>

/** objects.json raw 엔트리(템플릿 스탯 + 인스턴스값 shotscur·description 포함). */
export interface RawObjectTemplate {
  readonly id: number
  readonly name: string
  readonly description: string
  readonly value: number
  readonly weight: number
  readonly type: number
  readonly adjustment: number
  readonly shotsmax: number
  readonly shotscur: number
  readonly ndice: number
  readonly sdice: number
  readonly pdice: number
  readonly armor: number
  readonly wearflag: number
  readonly magicpower: number
  readonly magicrealm: number
  readonly special: number
  readonly questnum: number
  readonly flags: string
}

/**
 * raw objects 배열을 objnum 인덱스로 만든다. 필요한 필드만 복사해 raw 번들과 분리한다.
 * type>14(게시판 엔트리 100~120)는 objectSchema type cap 밖이라 제외한다.
 */
export function buildObjectTemplateIndex(raw: readonly RawObjectTemplate[]): ObjectTemplateIndex {
  const map = new Map<number, ObjectTemplate>()
  for (const o of raw) {
    if (o.type > MAX_OBJECT_TYPE) continue
    map.set(o.id, {
      objnum: o.id,
      name: o.name,
      type: o.type,
      value: o.value,
      weight: o.weight,
      adjustment: o.adjustment,
      shotsmax: o.shotsmax,
      ndice: o.ndice,
      sdice: o.sdice,
      pdice: o.pdice,
      armor: o.armor,
      wearflag: o.wearflag,
      magicpower: o.magicpower,
      magicrealm: o.magicrealm,
      special: o.special,
      questnum: o.questnum,
      flags: o.flags,
    })
  }
  return map
}

/** 부팅 시 objects.json을 읽어 object 템플릿 인덱스를 만든다(조립 지점 seam). */
export function loadObjectTemplates(worldRoot?: string): ObjectTemplateIndex {
  const raw = loadWorldFile<RawObjectTemplate[]>('objects.json', worldRoot)
  return buildObjectTemplateIndex(raw)
}

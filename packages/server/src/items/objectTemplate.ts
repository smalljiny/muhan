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
 * 이름 매칭용 별칭 `keys`는 스탯이 아니지만 인덱스가 싣는다(근거: `ObjectTemplate.keys` doc).
 */

/** objectSchema type cap(0~14) — 이보다 큰 type은 게시판 엔트리(100~120)로 인덱스에서 제외한다. */
const MAX_OBJECT_TYPE = 14

/** object 템플릿 = 아이템 스탯 서브셋(인스턴스 런타임값 shotscur·description 제외). */
export interface ObjectTemplate {
  readonly objnum: number
  readonly name: string
  /**
   * 이름 매칭용 별칭(콘텐츠, 불변) — 원본 `char key[3][20]`을 위생 처리한 배열.
   *
   * 오라클 `EQUAL`(`legacy/muhan/src/mtype.h:579`)이 `name` + `key[0..2]` 네 필드를 함께 검사하므로,
   * 이름으로 아이템을 지목하는 경로는 `name` 단독으로 재현되지 않는다. 인스턴스 쪽 `ItemInstance.keys`
   * (`shared/src/worldGraph.ts`)와 달리 **필수 필드**로 둔다 — 템플릿은 인덱스가 단독 생산하므로
   * 흩어진 리터럴이 없어 필수화 비용이 픽스처 1곳뿐이다. (매처 `NameMatchable.keys`는 여전히 선택이라
   * 하류 분기가 사라지지는 않는다 — 필수화의 이득은 이 모듈 안에서 끝난다.)
   *
   * 소비자는 인벤 스코프 이름 해소자(#120 study 대상 해소)다.
   */
  readonly keys: readonly string[]
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
  /** 별칭 3슬롯(`char key[3][20]`)의 위생 산출물. 합성 픽스처 대비 선택 필드다(worldGraph raw 선례). */
  readonly keys?: readonly string[]
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
 * 별칭 슬롯을 위생 처리한다 — 각 원소를 trim하고 빈 것을 드롭해 새 배열로 복사한다.
 * 미보유(`undefined`)는 `[]`로 정규화한다.
 *
 * ⚠ 이 위생의 1차 소유자는 상류 리더 `packages/port/templates.js`의 `readKeys`다 — 거기서 이미
 * trim + 빈 슬롯 드롭을 하므로 정본 데이터(`objects.json` 709엔트리)에서 이 함수는 무발화다.
 * 여기서 한 번 더 하는 것은 수기 픽스처·후속 데이터 경로에 대한 이중 방어일 뿐이고,
 * 형제 경로(`world/worldGraph.ts`·`creatureFactory.ts`·`spawn.ts`)는 `[...(raw.keys ?? [])]`로
 * 리더 위생을 그대로 신뢰한다. 즉 같은 소스 필드에 위생 강도가 두 갈래로 갈려 있다.
 * 통일한다면 `shared/src/naming/` 쪽(매처 옆)에 헬퍼 하나를 두고 네 지점이 함께 부르는 것이 맞다.
 *
 * trim은 보관값에도 필요하다 — 소비자 `matchTarget`이 `key.startsWith(query)`라 선행 공백이
 * 남으면 매칭이 조용히 깨진다. 반면 빈 슬롯 드롭은 매칭 폭과 무관하다(빈 `key`는 빈 `query`에만
 * 매치하고, 빈 query는 이미 `name`으로 전 후보에 매치한다) — 형상 정규화 목적이다.
 */
function sanitizeKeys(keys: readonly string[] | undefined): readonly string[] {
  if (keys === undefined) return []
  return keys.map((k) => k.trim()).filter((k) => k.length > 0)
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
      keys: sanitizeKeys(o.keys),
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

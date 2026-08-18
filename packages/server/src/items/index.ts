/**
 * items 배럴 — 아이템 타입 taxonomy·착용 슬롯 매핑의 공개 표면.
 *
 * 오라클(mtype.h)의 object 타입(0~14)·착용 wearflag(1~20) 상수, 무기 판정(isWeapon),
 * 착용 명령 라우팅(routeWearCommand)·다중슬롯 해소(resolveSlot)를 노출한다.
 */
export {
  // object 타입 상수(0~14)
  SHARP,
  THRUST,
  BLUNT,
  POLE,
  MISSILE,
  ARMOR,
  POTION,
  SCROLL,
  WAND,
  CONTAINER,
  MONEY,
  KEY,
  LIGHTSOURCE,
  MISC,
  CONTAINER2,
  isWeapon,
  // 착용 슬롯 상수(wearflag 1~20)
  BODY,
  ARMS,
  LEGS,
  NECK1,
  NECK2,
  HANDS,
  HEAD,
  FEET,
  FINGER1,
  FINGER2,
  FINGER3,
  FINGER4,
  FINGER5,
  FINGER6,
  FINGER7,
  FINGER8,
  HELD,
  SHIELD,
  FACE,
  WIELD,
  MAXWEAR,
  routeWearCommand,
  resolveSlot,
  type WearCommand,
} from './taxonomy.js'

export {
  // object 플래그 비트 상수(mtype.h)
  ONOMAG,
  OGOODO,
  OEVILO,
  OENCHA,
  OSIZE1,
  OSIZE2,
  ORENCH,
  OWEARS,
  ONOMAL,
  ONOFEM,
  OCLSEL,
  ONSHAT,
  OMARRI,
  OEVENT,
  OWHELD,
  ONEWEV,
  // 종족 상수(RACE)
  DWARF,
  ELF,
  HALFELF,
  HOBBIT,
  HUMAN,
  ORC,
  HALFGIANT,
  GNOME,
  // 성별 상수
  MALE,
  FEMALE,
  // 게이트 predicate
  genderAllowed,
  alignmentAllowed,
  classAllowed,
  oclselBlocks,
  sizeAllowed,
  isCursed,
  isPersonalBound,
  isMarriageGated,
  needsRandEnchant,
} from './flags.js'

export {
  // object 템플릿 인덱스(objnum → ObjectTemplate)
  buildObjectTemplateIndex,
  loadObjectTemplates,
  type ObjectTemplate,
  type ObjectTemplateIndex,
} from './objectTemplate.js'

export {
  // 착용 장비 파생 스탯 투영(EffectiveStatContext 기여 부분집합)
  projectEquipStats,
  type EquippedPair,
  type EquipStatContribution,
} from './equipStats.js'

export {
  // 인스턴스↔템플릿 결합(EquippedPair 단일 출처) — 미해소는 호출자가 판단한다
  pairObject,
  pairObjects,
} from './objectPairing.js'

export {
  // 인벤 스코프 이름 해소자(오라클 study 2단 탐색 — find_obj 인벤 → ready 착용 스캔)
  resolveCarriedObject,
  type CarriedObjectResolver,
} from './carriedTargetResolver.js'

export {
  // 방어구 착용 다층 게이트·슬롯 배치(오라클 command3.c wear)
  wearGate,
  // 무기 장착(ready)·쥠(hold) 다층 게이트(오라클 command3.c ready/hold)
  readyGate,
  holdGate,
  type WearActor,
  type WearParams,
  type ReadyParams,
  type HoldParams,
  type WearOutcome,
} from './wear.js'

export {
  // rand_enchant 확률 순수 함수(오라클 object.c) — draw>98→+3(2%)·>90→+2·>50→+1·≤50→무변화
  randEnchant,
  type EnchantResult,
} from './enchant.js'

export {
  // 소비 아이템 magic 배달 seam(오라클 magic1.c drink/readscroll/zap) — splno=magicpower-1, gated=false
  deliverConsumable,
  type ConsumeContext,
  type ConsumeOutcome,
  type DeliverConsumableParams,
} from './consume.js'

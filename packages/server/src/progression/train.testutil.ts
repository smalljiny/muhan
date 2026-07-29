import { setFlag } from '../world/door.js'
import { RTRAIN } from './train.js'

/**
 * 훈련방 flag 픽스처 헬퍼 — `checkLocation`(train.ts)의 class-bit 역순 매칭 규칙 단일 출처.
 *
 * 방 비트 규칙은 base `RTRAIN`(3) + class-bit 서브매칭이고, 서브매칭 비트는 **역순** `RTRAIN+3-i`
 * (i=0→bit6·i=1→bit5·i=2→bit4)로 대조된다. 이 역순이 정확히 이 규칙의 함정이라(정순으로 구현하면
 * class2 같은 비대칭 클래스에서만 어긋난다), 소비자마다 손으로 재구현하면 한 곳이 틀려도 그 파일의
 * 테스트는 자기 구현과 일관되게 통과해버린다. 규칙을 여기 한 번만 두어 그 드리프트를 차단한다.
 *
 * 파일명이 `.testutil.ts`라 server build(tsconfig.build.json)·coverage(vitest.config.ts) 양쪽
 * glob에서 자동 제외된다(테스트 인프라, 프로덕션 코드 아님).
 */

/**
 * class N이 연마할 수 있는 훈련방의 flags(number[] 바이트 배열)를 만든다.
 *
 * 무적(class≥9)은 class-bit 서브매칭이 면제되므로 base `RTRAIN`만으로 충분하고, 이 함수에 class 9·10을
 * 넘겨도 (idx의 하위 3비트에 해당하는) 비트가 더 붙을 뿐 base 비트는 항상 포함되어 통과한다.
 */
export function trainingFlagsForClass(cls: number): number[] {
  const flags: number[] = [0]
  setFlag(flags, RTRAIN)
  const idx = cls - 1
  for (let i = 0; i < 3; i++) {
    if ((idx & (1 << i)) !== 0) setFlag(flags, RTRAIN + 3 - i)
  }
  return flags
}

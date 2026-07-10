// vitest 전역 셋업 — Story 2·3이 재사용하는 단일 하네스.
// `/vitest` 서브패스를 써야 vitest expect 타입 확장과 런타임 매처가 함께 붙는다.
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// globals: false 환경에서는 RTL 자동 cleanup이 등록되지 않으므로 명시적으로 배선한다.
// 이게 없으면 여러 테스트에서 렌더한 DOM이 다음 테스트로 누수된다.
afterEach(() => {
  cleanup()
})

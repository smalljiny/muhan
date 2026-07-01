/**
 * shared — server·client가 공유하는 단일 출처 타입.
 *
 * E1에서는 툴체인 검증용 최소 타입만 노출한다. 게임 도메인 타입(방·아이템·몬스터·
 * 플레이어)은 후속 에픽에서 이 패키지에 추가된다.
 */

/** `/health` 엔드포인트 응답 형태. server·client가 함께 참조한다. */
export type HealthStatus = { status: 'ok' }

export { loadWorldFile } from './worldLoader.js'

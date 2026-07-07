/**
 * 와이어 프로토콜 버전 — 봉투·payload 계약의 호환성 단일 출처.
 *
 * 계약이 하위 비호환으로 바뀔 때마다 1씩 단조 증가시킨다. 핸드셰이크(system:ready·system:hello)가
 * 이 값을 실어 client·server가 같은 계약 세대를 쓰는지 대조한다.
 */
export const PROTOCOL_VERSION = 1

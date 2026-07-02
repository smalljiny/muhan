import type { Db } from 'mongodb'

/**
 * DB ping 프로브. `{ ping: 1 }` 커맨드를 감싸 성공 시 true, 예외 시 false를 반환한다.
 *
 * 예외를 밖으로 던지지 않는다 — `/health`가 이 반환값을 진실의 원천으로 삼는다.
 */
export async function pingDb(db: Db): Promise<boolean> {
  try {
    await db.command({ ping: 1 })
    return true
  } catch {
    return false
  }
}

import { z } from 'zod'

// 환경변수 스키마 — 시작 시 파싱해 잘못된 설정이면 즉시 종료한다.
// MONGODB_URI는 존재만 검증한다(z.string().min(1)). z.url()은 generic URL 검증이라
// 유효한 seed-list 복제셋 URI(mongodb://h1:27017,h2:27017/db)를 false-reject하므로,
// 연결 문자열 문법 검증은 드라이버(Story 4 connectMongo)에 맡기고 여기선 부재만 잡는다.
// 빈 문자열(.env의 KEY= )은 .default()를 우회하므로 문자열 필드에 .min(1)을 건다.
// zod 4 관용: z.flattenError(구식 error.flatten() 대신).
export const EnvSchema = z.object({
  MONGODB_URI: z.string().min(1),
  MONGODB_DB_NAME: z.string().min(1).default('muhan_db_dev'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
})

export type Env = z.infer<typeof EnvSchema>

let configInstance: Env | undefined

export function getConfig(): Env {
  if (configInstance) return configInstance
  const result = EnvSchema.safeParse(process.env)
  if (!result.success) {
    console.error('Invalid environment variables:', z.flattenError(result.error).fieldErrors)
    process.exit(1)
  }
  configInstance = result.data
  return configInstance
}

/**
 * 테스트 전용 — 캐시된 싱글턴을 초기화한다.
 * process.env를 조작하는 테스트 간 격리를 위해서만 사용한다.
 */
export function resetConfigForTests(): void {
  configInstance = undefined
}

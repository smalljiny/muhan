// 세션 진입 중 발생한 오류를 사용자용 메시지로 표시하는 순수 렌더 컴포넌트. WsClient를 참조하지 않는다.
// error가 null이면 아무것도 렌더하지 않고, code별로 구분된 안내와 서버 원본 message를 함께 표시한다.
import type { ErrorCode } from 'shared/protocol'

// ErrorCode → 사용자 안내 문구 매핑. 매핑에 없는 코드는 일반 오류 안내로 폴백한다.
const CODE_GUIDANCE: Partial<Record<ErrorCode, string>> = {
  unauthorized: '인증이 만료되었습니다. 재인증이 필요합니다.',
  forbidden: '권한이 없습니다.',
  session_state: '세션 상태가 올바르지 않습니다. 다시 입력해 주세요.',
}

const FALLBACK_GUIDANCE = '오류가 발생했습니다.'

export interface SessionErrorBannerProps {
  error: { code: ErrorCode; message: string } | null
}

export function SessionErrorBanner({ error }: SessionErrorBannerProps) {
  if (error === null) {
    return null
  }
  const guidance = CODE_GUIDANCE[error.code] ?? FALLBACK_GUIDANCE
  return (
    <div role="alert">
      <p>{guidance}</p>
      <p>{error.message}</p>
    </div>
  )
}

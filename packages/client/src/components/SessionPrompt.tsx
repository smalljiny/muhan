// 세션 진입 다단 대화의 제네릭 prompt 렌더 컴포넌트. WsClient를 참조하지 않고 prop 주입만으로 동작한다.
// options가 있으면 라벨 버튼을, 없으면 텍스트 입력을 렌더한다. 버튼은 option.value를 가공 없이 그대로
// 콜백에 전달한다(create-entry 등 매직값 하드코딩 없음).
import { useState, type FormEvent } from 'react'
import type { PromptKind, PromptOption } from 'shared/protocol'

// createField 단계별 화면 안내 문구. promptId → 안내 텍스트 매핑의 단일 출처.
// confirm 단계는 사용자가 화면 정보만으로 완주하도록 요구 확인값 'yes'를 표시 텍스트에 명시한다.
const STEP_GUIDANCE: Record<string, string> = {
  'create:name': '캐릭터 이름을 입력하세요.',
  'create:class': '클래스 정수 코드를 입력하세요.',
  'create:race': '종족 정수 코드를 입력하세요.',
  'create:confirm': "생성을 확인하려면 yes를 입력하세요.",
}

const FALLBACK_GUIDANCE = '값을 입력하세요.'

export interface SessionPromptProps {
  prompt: {
    promptId: string
    kind: PromptKind
    options?: readonly PromptOption[]
  }
  onSelectOption: (value: string) => void
  onSubmitText: (value: string) => void
}

export function SessionPrompt({ prompt, onSelectOption, onSubmitText }: SessionPromptProps) {
  const [text, setText] = useState('')

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (text === '') return
    onSubmitText(text)
    setText('')
  }

  if (prompt.options && prompt.options.length > 0) {
    return (
      <div aria-label="선택지">
        {prompt.options.map((option) => (
          <button key={option.value} type="button" onClick={() => onSelectOption(option.value)}>
            {option.label}
          </button>
        ))}
      </div>
    )
  }

  const guidance = STEP_GUIDANCE[prompt.promptId] ?? FALLBACK_GUIDANCE

  return (
    <form onSubmit={handleSubmit}>
      <p>{guidance}</p>
      <input value={text} onChange={(event) => setText(event.target.value)} />
      <button type="submit">확인</button>
    </form>
  )
}

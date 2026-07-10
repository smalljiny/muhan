// 텍스트 입력을 debug:echo로 송신하는 경량 입력 폼. submit 시 주입된 onSubmitEcho 콜백을 호출하고
// 입력을 클리어한다. 빈 문자열은 wsClient freeText min(1) 위반이므로 UI에서 막는다(콜백 미호출).
import { useState, type FormEvent } from 'react'

export interface CommandInputProps {
  onSubmitEcho: (text: string) => void
}

export function CommandInput({ onSubmitEcho }: CommandInputProps) {
  const [text, setText] = useState('')

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (text === '') return
    onSubmitEcho(text)
    setText('')
  }

  return (
    <form onSubmit={handleSubmit}>
      <label htmlFor="command-input">명령</label>
      <input
        id="command-input"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <button type="submit">보내기</button>
    </form>
  )
}

// 캐릭터 선택 화면의 순수 렌더 컴포넌트. WsClient를 참조하지 않고 prop 주입만으로 동작한다.
// class·race는 카탈로그 없이 원시 정수 코드로 표시한다(E6 범위 밖).
import type { CharacterSummary } from 'shared/protocol'

export interface CharacterCardProps {
  character: CharacterSummary
  onSelect: (characterId: string) => void
}

export function CharacterCard({ character, onSelect }: CharacterCardProps) {
  const { characterId, name, level, class: klass, race } = character
  return (
    <div aria-label="캐릭터">
      <span>{name}</span> <span>Lv.{level}</span>
      <span>클래스 {klass}</span> <span>종족 {race}</span>
      <button type="button" onClick={() => onSelect(characterId)}>
        선택
      </button>
    </div>
  )
}

export interface CharacterListProps {
  characters: readonly CharacterSummary[]
  onSelect: (characterId: string) => void
}

export function CharacterList({ characters, onSelect }: CharacterListProps) {
  if (characters.length === 0) {
    return <p>캐릭터가 없습니다</p>
  }
  return (
    <div aria-label="캐릭터 목록">
      {characters.map((character) => (
        <CharacterCard key={character.characterId} character={character} onSelect={onSelect} />
      ))}
    </div>
  )
}

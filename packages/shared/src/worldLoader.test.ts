import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadWorldFile } from './index.js'

describe('loadWorldFile', () => {
  it('존재하는 world 파일을 파싱해 객체로 반환한다', () => {
    const room = loadWorldFile('rooms/r00000.json')

    expect(room).toBeTypeOf('object')
    expect(room).not.toBeNull()
  })

  it('존재하지 않는 파일은 명시적 에러를 던진다', () => {
    expect(() => loadWorldFile('rooms/does-not-exist-9999.json')).toThrow(/읽을 수 없습니다/)
  })

  it('worldRoot를 벗어나는 상대경로(../)는 경계 에러를 던진다', () => {
    expect(() => loadWorldFile('../../package.json')).toThrow(/worldRoot를 벗어났습니다/)
  })

  it('절대경로는 경계 에러를 던진다', () => {
    expect(() => loadWorldFile('/etc/passwd')).toThrow(/worldRoot를 벗어났습니다/)
  })

  it('잘못된 JSON은 명시적 에러를 던진다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muhan-world-'))
    writeFileSync(join(dir, 'bad.json'), '{ not valid json')
    try {
      expect(() => loadWorldFile('bad.json', dir)).toThrow(/JSON 파싱 실패/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

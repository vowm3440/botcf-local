import { describe, expect, it } from 'vitest'
import { wordSegments } from '../src/editor/wordDiff'

describe('wordSegments', () => {
  it('emphasizes only the part that differs', () => {
    const [removed, added] = wordSegments('const a = 1', 'const b = 1')
    expect(removed).toEqual([
      { text: 'const ', emphasized: false },
      { text: 'a', emphasized: true },
      { text: ' = 1', emphasized: false }
    ])
    expect(added).toEqual([
      { text: 'const ', emphasized: false },
      { text: 'b', emphasized: true },
      { text: ' = 1', emphasized: false }
    ])
  })

  it('emphasizes an appended tail on the added side only', () => {
    const [removed, added] = wordSegments('value', 'value + 1')
    expect(removed).toEqual([{ text: 'value', emphasized: false }])
    expect(added).toEqual([
      { text: 'value', emphasized: false },
      { text: ' + 1', emphasized: true }
    ])
  })

  it('emphasizes nothing when the lines match', () => {
    const [removed, added] = wordSegments('same', 'same')
    expect(removed).toEqual([{ text: 'same', emphasized: false }])
    expect(added).toEqual([{ text: 'same', emphasized: false }])
  })

  it('keeps a shared prefix and suffix around a longer replacement', () => {
    const [removed, added] = wordSegments('if (a) return', 'if (a && b) return')
    expect(removed.filter((segment) => segment.emphasized).map((segment) => segment.text)).toEqual([])
    expect(added.filter((segment) => segment.emphasized).map((segment) => segment.text)).toEqual([' && b'])
  })

  it('handles an empty side', () => {
    const [removed, added] = wordSegments('', 'added')
    expect(removed).toEqual([])
    expect(added).toEqual([{ text: 'added', emphasized: true }])
  })
})

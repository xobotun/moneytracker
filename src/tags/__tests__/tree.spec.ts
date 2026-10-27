import { describe, it, expect } from 'vitest'
import { asShortId } from '@/db/shortId'
import type { Tag } from '@/db/types'
import {
  buildTree,
  filterTree,
  pathLabel,
  subtreeIds,
  tagMatches,
  tagOptions,
  tagPath,
  type TagNode,
} from '../tree'
import { byId, tag } from './fixtures'

const DELETED = new Date('2026-10-27T00:00:00.000Z')
const under = (parent: string) => ({ parent_id: asShortId(parent) })

/** The tree as nested names, for readable assertions. */
function shape(nodes: readonly TagNode[]): unknown[] {
  return nodes.map((n) =>
    n.children.length === 0 ? n.tag.name : { [n.tag.name]: shape(n.children) },
  )
}

describe('buildTree', () => {
  it('nests children under their parents, sorted by name', () => {
    const tags = [
      tag('food', { name: 'Food' }),
      tag('snacks', { name: 'snacks', ...under('food') }),
      tag('bakery', { name: 'Bakery', ...under('food') }),
      tag('chips', { name: 'Chips', ...under('snacks') }),
      tag('cars', { name: 'cars' }),
    ]
    expect(shape(buildTree(tags, 'category'))).toEqual([
      'cars',
      { Food: ['Bakery', { snacks: ['Chips'] }] },
    ])
  })

  it('breaks name ties by id', () => {
    const tags = [tag('b', { name: 'Rewe' }), tag('a', { name: 'rewe' })]
    expect(buildTree(tags, 'category').map((n) => n.tag.id)).toEqual(['a', 'b'])
  })

  it('leaves out deleted tags and other kinds', () => {
    const tags = [
      tag('food'),
      tag('gone', { deleted_at_utc: DELETED }),
      tag('rewe', { kind: 'merchant' }),
    ]
    expect(shape(buildTree(tags, 'category'))).toEqual(['food'])
  })

  it('puts a tag whose parent is not live at the top level', () => {
    const tags = [
      tag('gone', { deleted_at_utc: DELETED }),
      tag('orphan', under('gone')),
      tag('lost', under('missing0001')),
      tag('mixed', under('rewe')),
      tag('rewe', { kind: 'merchant' }),
    ]
    expect(shape(buildTree(tags, 'category'))).toEqual(['lost', 'mixed', 'orphan'])
  })

  it('shows tags caught in a parent loop once, from the top level', () => {
    const tags = [tag('a', under('b')), tag('b', under('a')), tag('c', under('b'))]
    expect(shape(buildTree(tags, 'category'))).toEqual([{ a: [{ b: ['c'] }] }])
  })
})

describe('filterTree', () => {
  const tags = [
    tag('food'),
    tag('groceries', under('food')),
    tag('bakery', under('food')),
    tag('fun'),
  ]
  const tree = buildTree(tags, 'category')

  it('keeps matches and their ancestors only', () => {
    expect(shape(filterTree(tree, (t) => t.name === 'bakery'))).toEqual([{ food: ['bakery'] }])
  })

  it('drops the descendants of a match that do not match', () => {
    expect(shape(filterTree(tree, (t) => t.name === 'food'))).toEqual(['food'])
  })

  it('keeps everything for a filter that matches all', () => {
    expect(filterTree(tree, () => true)).toEqual(tree)
  })
})

describe('tagMatches', () => {
  const rewe = tag('rewe', { name: 'Rewe', synonyms: ['REWE Markt'] })

  it('matches everything for an empty query', () => {
    expect(tagMatches(rewe, '  ', [])).toBe(true)
  })

  it('finds a name, a synonym or a merged name, ignoring case', () => {
    expect(tagMatches(rewe, 'ewe', [])).toBe(true)
    expect(tagMatches(rewe, 'markt', [])).toBe(true)
    expect(tagMatches(rewe, 'billa', ['Billa Wien'])).toBe(true)
    expect(tagMatches(rewe, 'edeka', [])).toBe(false)
  })
})

describe('tagPath and pathLabel', () => {
  it('names the tag and its ancestors from the top', () => {
    const map = byId(
      tag('food', { name: 'Food' }),
      tag('groceries', { name: 'Groceries', ...under('food') }),
    )
    expect(pathLabel(tagPath(map.get(asShortId('groceries'))!, map))).toBe('Food › Groceries')
  })

  it('stops on a loop', () => {
    const map = byId(tag('a', under('b')), tag('b', under('a')))
    expect(tagPath(map.get(asShortId('a'))!, map)).toEqual(['b', 'a'])
  })
})

describe('subtreeIds', () => {
  it('covers the tag and its live descendants, and survives a loop', () => {
    const tags: Tag[] = [
      tag('food'),
      tag('groceries', under('food')),
      tag('bread', under('groceries')),
      tag('gone', { ...under('food'), deleted_at_utc: DELETED }),
      tag('fun'),
      tag('x', under('y')),
      tag('y', under('x')),
    ]
    expect([...subtreeIds(asShortId('food'), tags)].sort()).toEqual(['bread', 'food', 'groceries'])
    expect([...subtreeIds(asShortId('x'), tags)].sort()).toEqual(['x', 'y'])
  })
})

describe('tagOptions', () => {
  it('lists live tags of the kind by path, without the excluded ones', () => {
    const tags = [
      tag('food', { name: 'Food' }),
      tag('groceries', { name: 'Groceries', ...under('food') }),
      tag('bakery', { name: 'Bakery', ...under('food') }),
      tag('drinks', { name: 'Drinks' }),
      tag('gone', { name: 'Gone', deleted_at_utc: DELETED }),
      tag('rewe', { name: 'Rewe', kind: 'merchant' }),
    ]
    expect(tagOptions(tags, 'category', new Set([asShortId('bakery')]))).toEqual([
      { id: 'drinks', label: 'Drinks' },
      { id: 'food', label: 'Food' },
      { id: 'groceries', label: 'Food › Groceries' },
    ])
  })
})

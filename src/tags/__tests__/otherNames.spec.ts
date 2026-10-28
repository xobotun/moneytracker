import { describe, it, expect } from 'vitest'
import { asShortId } from '@/db/shortId'
import {
  applyOtherNames,
  carriedNames,
  cleanOtherNames,
  mergedNames,
  mergedNamesByTag,
  namesAddedByMerge,
  namesFindingTargetAfterMerge,
  retiredAfterMerge,
} from '../otherNames'
import { merged, tag } from './fixtures'

describe('cleanOtherNames', () => {
  it('trims, drops empty ones, the main name and repeats ignoring case', () => {
    expect(cleanOtherNames('Rewe', [' REWE Markt ', '', 'rewe', 'Rewe markt', 'Billa'])).toEqual([
      'REWE Markt',
      'Billa',
    ])
  })
})

describe('carriedNames', () => {
  const work = tag('work')
  const job = merged('job', 'work', { synonyms: ['occupation'] })
  const side = merged('side job', 'job')
  const other = tag('other')

  it('follows the merge chains that end at the tag', () => {
    expect(carriedNames(work.id, [job, other, side, work])).toEqual([
      'job',
      'occupation',
      'side job',
    ])
    expect(carriedNames(other.id, [job, other, side, work])).toEqual([])
  })

  it('lists a name once, in its first spelling', () => {
    const jobs = merged('Jobs', 'work', { synonyms: ['JOB'] })
    expect(carriedNames(work.id, [job, jobs, work])).toEqual(['job', 'occupation', 'Jobs'])
  })

  it('stops on a merge cycle', () => {
    const a = merged('a', 'b')
    const b = merged('b', 'a')
    expect(carriedNames(asShortId('a'), [a, b])).toEqual([])
  })
})

describe('mergedNames', () => {
  it("leaves out the tag's own names and retired ones", () => {
    const work = tag('work', { synonyms: ['Job'], retired_names: ['occupation'] })
    const job = merged('job', 'work', { synonyms: ['occupation', 'gig', 'WORK'] })
    expect(mergedNames(work, [job, work])).toEqual(['gig'])
  })
})

describe('applyOtherNames', () => {
  const plain = { name: 'work', synonyms: [] as string[], retired_names: [] as string[] }

  it('retires a removed merged name', () => {
    expect(applyOtherNames({ ...plain, synonyms: ['job'] }, ['job'], [])).toEqual({
      synonyms: [],
      retired_names: ['job'],
    })
  })

  it('retires a removed merged name that was not a synonym', () => {
    expect(applyOtherNames(plain, ['job'], [])).toEqual({ synonyms: [], retired_names: ['job'] })
  })

  it('drops a plain synonym without retiring it', () => {
    expect(applyOtherNames({ ...plain, synonyms: ['WB'] }, [], [])).toEqual({
      synonyms: [],
      retired_names: [],
    })
  })

  it('keeps a merged-only name out of the synonyms', () => {
    expect(applyOtherNames(plain, ['job'], ['job'])).toEqual({ synonyms: [], retired_names: [] })
  })

  it('un-retires a name typed again', () => {
    expect(applyOtherNames({ ...plain, retired_names: ['job'] }, ['job'], ['Job'])).toEqual({
      synonyms: ['Job'],
      retired_names: [],
    })
  })

  it('keeps earlier retired names and adds new synonyms', () => {
    expect(
      applyOtherNames({ ...plain, retired_names: ['gig'] }, ['gig', 'job'], [' WB ', 'job']),
    ).toEqual({ synonyms: ['WB'], retired_names: ['gig'] })
  })

  it('never retires the main name', () => {
    expect(applyOtherNames({ ...plain, name: 'job' }, ['job'], [])).toEqual({
      synonyms: [],
      retired_names: [],
    })
  })
})

describe('mergedNamesByTag', () => {
  it('gives each tag its mergedNames in one pass', () => {
    const work = tag('work', { synonyms: ['Job'] })
    const other = tag('other')
    const tags = [
      work,
      other,
      merged('job', 'work', { synonyms: ['gig'] }),
      merged('side', 'job'),
      merged('a', 'b'),
      merged('b', 'a'),
    ]
    const byTag = mergedNamesByTag(tags)
    expect(byTag.get(work.id)).toEqual(mergedNames(work, tags))
    expect(byTag.get(work.id)).toEqual(['gig', 'side'])
    expect(byTag.get(other.id) ?? []).toEqual([])
  })
})

describe('retiredAfterMerge', () => {
  const target = { name: 'work', retired_names: ['old'] }

  it("keeps both sides' retired names", () => {
    expect(retiredAfterMerge(target, { retired_names: ['gone'] }, [], [])).toEqual(['old', 'gone'])
  })

  it('does not retire a name the target still has, as a synonym or a merged name', () => {
    const source = { retired_names: ['WB', 'gig', 'work'] }
    expect(retiredAfterMerge(target, source, ['wb'], ['Gig'])).toEqual(['old'])
  })
})

describe('namesAddedByMerge', () => {
  const food = { name: 'Food', synonyms: ['lunch', 'Eats'] }

  it("adds the source's name and synonyms the target lacks, in order", () => {
    expect(namesAddedByMerge({ name: 'Groceries', synonyms: ['Market'] }, food)).toEqual([
      'Groceries',
      'Market',
    ])
  })

  it("leaves out the target's name and synonyms, ignoring case", () => {
    const lunch = { name: 'Lunch', synonyms: ['Midday', 'FOOD', 'eats'] }
    expect(namesAddedByMerge(lunch, food)).toEqual(['Midday'])
  })

  it('keeps the first spelling of a repeated name', () => {
    const snack = { name: 'Snack', synonyms: ['snack', 'Bite', 'BITE'] }
    expect(namesAddedByMerge(snack, food)).toEqual(['Snack', 'Bite'])
  })

  it('adds nothing when the target has every name already', () => {
    expect(namesAddedByMerge({ name: 'LUNCH', synonyms: ['eats'] }, food)).toEqual([])
  })
})

describe('namesFindingTargetAfterMerge', () => {
  const work = tag('work', { synonyms: ['occupation'] })
  const job = merged('job', 'work', { synonyms: ['gig'] })
  const side = merged('side job', 'job')

  it("lists the source's own names, then the names merged into it, along the chain", () => {
    const career = tag('career')
    expect(namesFindingTargetAfterMerge(work, career, [job, side, work, career])).toEqual([
      'work',
      'occupation',
      'job',
      'gig',
      'side job',
    ])
  })

  it('leaves out the names the target has, merged ones included, ignoring case', () => {
    const career = tag('career', { synonyms: ['GIG'] })
    const oldJob = merged('old job', 'career', { name: 'JOB' })
    const oldWork = merged('old work', 'career', { name: 'Work' })
    expect(
      namesFindingTargetAfterMerge(work, career, [job, side, work, career, oldJob, oldWork]),
    ).toEqual(['occupation', 'side job'])
  })

  it('leaves out a merged name the target retired, but not an own name it retired', () => {
    const career = tag('career', { retired_names: ['Job', 'occupation'] })
    expect(namesFindingTargetAfterMerge(work, career, [job, side, work, career])).toEqual([
      'work',
      'occupation',
      'gig',
      'side job',
    ])
  })

  it("leaves out the source's retired names", () => {
    const retiring = tag('work', { retired_names: ['gig'] })
    const career = tag('career')
    expect(namesFindingTargetAfterMerge(retiring, career, [job, retiring, career])).toEqual([
      'work',
      'job',
    ])
  })
})

import { describe, it, expect } from 'vitest'
import { asShortId } from '@/db/shortId'
import { applyOtherNames, carriedNames, cleanOtherNames, mergedNames } from '../otherNames'
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

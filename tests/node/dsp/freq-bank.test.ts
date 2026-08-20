import { describe, it, expect } from 'vitest'
import { FREQ_BANK, freqBankHz } from '../../../src/engine/dsp/freq-bank'

describe('FREQ_BANK: exact accuracy of every entry', () => {
  it('has sixteen entries -- nine Solfeggio, five Schumann, two reference pitches', () => {
    expect(FREQ_BANK.length).toBe(16)
  })

  it('every label is unique -- no two switch positions read the same', () => {
    const labels = FREQ_BANK.map((e) => e.label)
    expect(new Set(labels).size).toBe(labels.length)
  })

  // The literal claim of this module: each entry's `hz` is exactly the
  // number its label says, to the limit of what the source cites. Table
  // driven so the report and this test read the same values side by side.
  const EXPECTED: Array<[string, number]> = [
    ['174', 174],
    ['285', 285],
    ['396', 396],
    ['417', 417],
    ['528', 528],
    ['639', 639],
    ['741', 741],
    ['852', 852],
    ['963', 963],
    ['7.83', 7.83],
    ['14.3', 14.3],
    ['20.8', 20.8],
    ['27.3', 27.3],
    ['33.8', 33.8],
    ['A432', 432],
    ['A440', 440],
  ]

  it.each(EXPECTED)('%s is exactly %s Hz', (label, hz) => {
    const entry = FREQ_BANK.find((e) => e.label === label)
    expect(entry).toBeDefined()
    expect(entry!.hz).toBe(hz)
  })

  it('matches EXPECTED one-to-one, in order, with nothing extra or missing', () => {
    expect(FREQ_BANK.map((e) => [e.label, e.hz])).toEqual(EXPECTED)
  })
})

describe('freqBankHz: index -> exact frequency, with exact octave shifting', () => {
  it('reproduces each bank entry\'s frequency at octave 0', () => {
    for (let i = 0; i < FREQ_BANK.length; i++) {
      expect(freqBankHz(i, 0)).toBe(FREQ_BANK[i]!.hz)
    }
  })

  it('shifts by exact powers of two -- 528 Hz at +2 octaves is exactly 2112, not an approximation', () => {
    const index528 = FREQ_BANK.findIndex((e) => e.label === '528')
    expect(freqBankHz(index528, 0)).toBe(528)
    expect(freqBankHz(index528, 1)).toBe(1056)
    expect(freqBankHz(index528, 2)).toBe(2112)
    expect(freqBankHz(index528, -1)).toBe(264)
    expect(freqBankHz(index528, -2)).toBe(132)
  })

  it('every entry stays exactly representable across the full -2..2 octave range', () => {
    for (const entry of FREQ_BANK) {
      const index = FREQ_BANK.indexOf(entry)
      for (const octave of [-2, -1, 0, 1, 2]) {
        const expected = entry.hz * 2 ** octave
        expect(freqBankHz(index, octave)).toBe(expected)
      }
    }
  })

  it('clamps an out-of-range index rather than returning undefined or throwing', () => {
    expect(freqBankHz(-5)).toBe(FREQ_BANK[0]!.hz)
    expect(freqBankHz(999)).toBe(FREQ_BANK[FREQ_BANK.length - 1]!.hz)
  })

  it('rounds a fractional index to the nearest bank entry', () => {
    expect(freqBankHz(4.4)).toBe(FREQ_BANK[4]!.hz)
    expect(freqBankHz(4.6)).toBe(FREQ_BANK[5]!.hz)
  })

  it('defaults octave to 0 when omitted', () => {
    expect(freqBankHz(4)).toBe(freqBankHz(4, 0))
  })
})

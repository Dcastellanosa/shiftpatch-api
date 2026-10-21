import { describe, expect, it } from 'vitest'
import { fromLocalDateTime, toLocalDateTime } from './local-time.js'

describe('toLocalDateTime', () => {
  it('reads the wall clock of an instant in a zone', () => {
    expect(toLocalDateTime('2026-10-02T19:00:00.000Z', 'UTC')).toEqual({ date: '2026-10-02', time: '19:00' })
    expect(toLocalDateTime('2026-10-02T23:00:00.000Z', 'America/New_York')).toEqual({ date: '2026-10-02', time: '19:00' })
    expect(toLocalDateTime('2026-10-03T07:00:00.000Z', 'UTC')).toEqual({ date: '2026-10-03', time: '07:00' })
  })

  it('zero-pads hours and minutes', () => {
    expect(toLocalDateTime('2026-01-05T03:07:00.000Z', 'UTC')).toEqual({ date: '2026-01-05', time: '03:07' })
  })
})

describe('fromLocalDateTime', () => {
  it('converts a wall clock in a zone to the UTC instant', () => {
    expect(fromLocalDateTime('2026-10-02', '19:00', 'UTC')).toBe('2026-10-02T19:00:00.000Z')
    expect(fromLocalDateTime('2026-10-02', '19:00', 'America/New_York')).toBe('2026-10-02T23:00:00.000Z')
    // Standard time after the DST change
    expect(fromLocalDateTime('2026-12-01', '19:00', 'America/New_York')).toBe('2026-12-02T00:00:00.000Z')
  })

  it('round-trips with toLocalDateTime', () => {
    const iso = fromLocalDateTime('2026-07-04', '06:30', 'Europe/Madrid')
    expect(toLocalDateTime(iso, 'Europe/Madrid')).toEqual({ date: '2026-07-04', time: '06:30' })
  })
})

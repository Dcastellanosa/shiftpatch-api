/**
 * Facility-local wall clock ⇄ UTC instant. Shifts are stored as UTC instants;
 * the contract exposes `date`, `startTime` and `endTime` in the branch's zone.
 * Pure `Intl`, no dependencies.
 */

export interface LocalDateTime {
  /** YYYY-MM-DD */
  date: string
  /** HH:MM, 24-hour */
  time: string
}

const parts = (instant: number, timeZone: string) => {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant))
  const get = (type: string) => formatted.find((p) => p.type === type)?.value ?? '00'
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') }
}

export function toLocalDateTime(iso: string, timeZone: string): LocalDateTime {
  const p = parts(Date.parse(iso), timeZone)
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` }
}

/** Offset (ms) of `timeZone` from UTC at `instant`. */
function zoneOffset(instant: number, timeZone: string): number {
  const p = parts(instant, timeZone)
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second))
  return asUtc - instant
}

/** `date` is YYYY-MM-DD and `time` HH:MM in `timeZone`; returns the ISO UTC instant. */
export function fromLocalDateTime(date: string, time: string, timeZone: string): string {
  const [y, m, d] = date.split('-').map(Number)
  const [hh, mm] = time.split(':').map(Number)
  const wallClock = Date.UTC(y!, m! - 1, d!, hh!, mm!)
  // Two passes settle the offset across DST transitions.
  let instant = wallClock - zoneOffset(wallClock, timeZone)
  instant = wallClock - zoneOffset(instant, timeZone)
  return new Date(instant).toISOString()
}

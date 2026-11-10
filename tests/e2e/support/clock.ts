/**
 * A fixed-offset IANA zone in which it is 12:xx right now. E2E locations use it so that specs
 * doing arithmetic around "now" (appointments minutes ahead, a finish time shifted by minutes)
 * never meet the location's midnight or its 04:00 service-day rollover, whatever time of day the
 * suite runs. A suite takes well under an hour, so the local time stays between 12:00 and 13:00.
 * A spec that needs a real zone (quiet hours, DST) sets its own tz and says why.
 */
export function noonTz(now: Date = new Date()): string {
  const offset = 12 - now.getUTCHours();
  return offset === 0 ? 'Etc/UTC' : `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}`;
}

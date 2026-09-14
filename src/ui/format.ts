/**
 * Time formatting.
 *
 * The board runs in Novosibirsk and the reader may be anywhere, so every
 * timestamp is shown in the browser's local zone and paired with UTC wherever
 * the exact instant matters.
 */

const LOCAL_DATE_TIME = new Intl.DateTimeFormat(undefined, {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const LOCAL_TIME = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const LOCAL_DAY = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: '2-digit',
  month: 'short',
});

export function formatLocal(unixSeconds: number): string {
  return LOCAL_DATE_TIME.format(new Date(unixSeconds * 1000));
}

export function formatLocalTime(unixSeconds: number): string {
  return LOCAL_TIME.format(new Date(unixSeconds * 1000));
}

export function formatLocalDay(unixSeconds: number): string {
  return LOCAL_DAY.format(new Date(unixSeconds * 1000));
}

export function formatUtc(unixSeconds: number): string {
  return `${new Date(unixSeconds * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** "4 min ago", "2 h 10 min ago". Future instants read as "just now". */
export function formatAge(seconds: number): string {
  if (!Number.isFinite(seconds)) return 'unknown';
  const total = Math.round(seconds);
  if (total < 45) return 'just now';
  if (total < 3600) return `${Math.round(total / 60)} min ago`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours < 24) return minutes ? `${hours} h ${minutes} min ago` : `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

/** Local date and time in a shape that is safe inside a file name. */
export function filenameStamp(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** `YYYY-MM-DD` in local time, the value shape of <input type="date">. */
export function dateInputValue(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatBytes(value: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(index === 0 || size >= 100 ? 0 : 1)} ${units[index]}`;
}

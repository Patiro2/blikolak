const SUFFIXES = ['', 'K', 'M', 'B', 'T', 'aa', 'ab', 'ac', 'ad', 'ae', 'af', 'ag'];

/** 1234 -> "1.23K", 45 -> "45", 7.5e9 -> "7.50B" */
export function fmt(n) {
  if (!isFinite(n)) return '∞';
  if (n < 0) return '-' + fmt(-n);
  if (n < 1000) return n < 10 ? (Math.round(n * 10) / 10).toString() : Math.floor(n).toString();

  let tier = Math.floor(Math.log10(n) / 3);
  if (tier >= SUFFIXES.length) tier = SUFFIXES.length - 1;
  const scaled = n / Math.pow(1000, tier);
  return scaled.toFixed(scaled < 10 ? 2 : scaled < 100 ? 1 : 0) + SUFFIXES[tier];
}

/** Krótszy wariant dla unoszących się napisów nad maszyną. */
export function fmtShort(n) {
  return n < 1000 ? Math.floor(n).toString() : fmt(n);
}

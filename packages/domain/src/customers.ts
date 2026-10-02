// Customer matching inputs: phones and shipping marks, normalised the same
// way the database stores them.

const IRAQ = "964";

/**
 * A phone number in international form, or null when it can't be one.
 * Numbers with no country code are read as Iraqi:
 * "0770 123 4567", "770 123 4567" and "+964 770 123 4567" all become
 * "+9647701234567".
 */
export function normalizePhone(input: string): string | null {
  const trimmed = input.trim();
  const international = trimmed.startsWith("+") || trimmed.startsWith("00");
  let digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("00")) digits = digits.slice(2);

  if (!international) {
    if (digits.startsWith(IRAQ) && digits.length === IRAQ.length + 10) {
      // already carries the country code, written without a plus
    } else {
      if (digits.startsWith("0")) digits = digits.slice(1);
      if (digits.length !== 10) return null;
      digits = IRAQ + digits;
    }
  }
  if (digits.startsWith(IRAQ) && digits.length !== IRAQ.length + 10) return null;
  if (!/^[1-9]\d{7,14}$/.test(digits)) return null;
  return `+${digits}`;
}

/** Upper case, single spaces, trimmed. The same rule as gs_normalize_mark in the database. */
export function normalizeMark(input: string): string {
  return input.trim().toUpperCase().replace(/\s+/g, " ");
}

/**
 * True when a mark from a file belongs to a prefix mark: YARO matches
 * "YARO", "YARO MHAMAD" and "YARO-OSMAN", but not "YAROSLAV".
 */
export function markHasPrefix(mark: string, prefix: string): boolean {
  const m = normalizeMark(mark);
  const p = normalizeMark(prefix);
  if (p.length === 0 || !m.startsWith(p)) return false;
  if (m.length === p.length) return true;
  return !/[\p{L}\p{N}]/u.test(m.charAt(p.length));
}

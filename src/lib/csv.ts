// ═══════════════════════════════════════════════════════════════════════════
// CSV cells that are safe to open.
//
// A CSV is not just text. Excel and Google Sheets EXECUTE a cell whose first
// character is `=`, `+`, `-`, `@`, a tab or a carriage return — so a value
// this product writes into an export can become a formula on the reader's
// machine. That is CWE-1236, and it matters here more than in most apps
// because of WHERE our exports come from and WHO opens them:
//
//   · the audit trail export carries `actor`, `action` and `category`
//     straight out of audit_events, and an action description can quote text
//     an end user typed;
//   · the support report export carries `end_user_name` and `subject`, both
//     of which the end user supplies directly;
//   · and the person opening either is, by design, a customer's auditor or
//     compliance reviewer. The export is the artifact we ask them to trust.
//
// The mitigation is OWASP's: prefix a leading trigger character with `'`, so
// the spreadsheet reads the cell as text. Nothing is dropped — the payload is
// still there to read, it just is not run.
//
// ⚠ EXCEPT for a negative number. `-1500` starts with a trigger, and quoting
// it as text would arrive in a financial export as a string, breaking every
// SUM the reader writes. A cell that parses as a finite number cannot be a
// formula, so numbers pass through unguarded.
// ═══════════════════════════════════════════════════════════════════════════

const TRIGGER = /^[=+\-@\t\r]/;

/** One CSV cell: always quoted, internal quotes doubled, formulas defused. */
export function csvCell(value: unknown): string {
  const s = value == null ? '' : String(value);
  const numeric = s.trim() !== '' && Number.isFinite(Number(s));
  const body = TRIGGER.test(s) && !numeric ? `'${s}` : s;
  // Quote unconditionally. Conditional quoting (only when the cell contains a
  // comma, quote or newline) is correct RFC 4180 and is what this repo did
  // before; it is also one `if` away from a cell that escapes its own column,
  // and it saves nothing a reader would notice.
  return `"${body.replace(/"/g, '""')}"`;
}

/** One CSV record. Use with '\r\n' between rows, per RFC 4180. */
export function csvRow(cells: readonly unknown[]): string {
  return cells.map(csvCell).join(',');
}

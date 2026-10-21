/** Postgres timestamptz text ("2026-10-21 12:55:00.12+02") → ISO 8601. */
export function toIso(pg: string | null): string | null {
  if (!pg) return null;
  let s = pg.replace(' ', 'T');
  if (/[+-]\d{2}$/.test(s)) s += ':00';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? pg : d.toISOString();
}

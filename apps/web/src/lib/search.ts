/** Lower case without diacritics, so "knez" finds "Knež" and "dorcol" finds "Dorćol". */
export function normalize(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'dj');
}

/** Items whose text contains every word of the query, at most `limit` of them. */
export function searchItems<T>(items: T[], query: string, text: (item: T) => string, limit: number): T[] {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  const out: T[] = [];
  for (const item of items) {
    const t = normalize(text(item));
    if (words.every((w) => t.includes(w))) out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

const MAP: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', ђ: 'đ', е: 'e', ж: 'ž', з: 'z', и: 'i', ј: 'j', к: 'k', л: 'l', љ: 'lj',
  м: 'm', н: 'n', њ: 'nj', о: 'o', п: 'p', р: 'r', с: 's', т: 't', ћ: 'ć', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'č',
  џ: 'dž', ш: 'š',
};

/** Serbian Cyrillic to Latin (gajica); other characters pass through. */
export function toLatin(text: string): string {
  let out = '';
  for (const ch of text) {
    const lower = ch.toLowerCase();
    const latin = MAP[lower];
    if (latin === undefined) out += ch;
    else if (ch === lower) out += latin;
    else out += latin.charAt(0).toUpperCase() + latin.slice(1);
  }
  return out;
}

/** Text normalization shared by on-device inference and the training script.
 * Changing it changes every feature key: retrain the bundled model afterwards. */

const DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۭ]/g;
const TATWEEL = /ـ/g;
const MAX_FEATURE_TEXT = 1_024;

export function normalizeText(text: string): string {
  return text.slice(0, MAX_FEATURE_TEXT).toLowerCase()
    .replace(DIACRITICS, '').replace(TATWEEL, '')
    .replace(/[آأإٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .replace(/[٠-٩]/g, digit => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, digit => String(digit.charCodeAt(0) - 0x06F0))
    // Keep Latin, Arabic letters and digits. Everything else separates words.
    .replace(/[^a-z0-9ء-ي]+/g, ' ')
    // Elongation ("helppp", "ساعدوووني", "ههههه") carries emphasis, not new words.
    .replace(/(.)\1{2,}/g, '$1$1')
    .trim();
}

export function tokenize(text: string): string[] {
  const normalized = normalizeText(text);
  return normalized === '' ? [] : normalized.split(' ');
}

/** Words, adjacent word pairs and padded character trigrams. Trigrams let
 * Arabic clitics (و، ب، ال) and English inflections share evidence. */
export function extractFeatures(text: string): string[] {
  const tokens = tokenize(text);
  const features: string[] = [];
  tokens.forEach((token, index) => {
    features.push(`w:${token}`);
    const next = tokens[index + 1];
    if (next !== undefined) features.push(`b:${token}_${next}`);
    const padded = `^${token}$`;
    if (padded.length > 3) {
      for (let start = 0; start + 3 <= padded.length; start += 1) features.push(`c:${padded.slice(start, start + 3)}`);
    }
  });
  return features;
}

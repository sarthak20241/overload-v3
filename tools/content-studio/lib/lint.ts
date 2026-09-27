/**
 * The founder never wants em dashes: they read as AI. Models still slip them
 * in, so every generated string goes through here before it is saved.
 */
export function cleanDashes(text: string): string {
  return text
    .replace(/(\d)\s*[–—]\s*(\d)/g, '$1 to $2')
    .replace(/\s*—\s*/g, ', ')
    .replace(/\s+–\s+/g, ', ')
    .replace(/–/g, '-')
    .replace(/,\s*,/g, ',')
    .replace(/,\s*([.!?:])/g, '$1');
}

export function hasDashes(text: string): boolean {
  return /[–—]/.test(text);
}

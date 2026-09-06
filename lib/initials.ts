/**
 * Avatar initials for a person's name: first letter of the first two
 * whitespace-separated words, uppercased. A single-word name yields one
 * letter. Empty/whitespace input yields an empty string.
 */
export function initials(name: string): string {
  return name
    .split(' ')
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

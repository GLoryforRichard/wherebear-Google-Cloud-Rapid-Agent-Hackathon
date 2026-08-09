/**
 * Normalized identity key for a product name — the upsert/merge filter for the
 * `products` collection (unique index `name_key`).
 *
 * Why: the vision model reads the same SKU slightly differently across scans
 * ("Coffee-mate" vs "Coffee-Mate", "with" vs "With"), and an exact-match
 * upsert on canonical_name then forks the product into duplicate docs — the
 * old doc keeps advertising a shelf the item has left. Keying on a
 * case/punctuation-insensitive form makes re-scans land on the same doc.
 *
 * NFKC first so full-width characters collapse to ASCII before lowercasing;
 * \p{L}\p{N} keeps CJK intact while every punctuation/space run becomes one
 * separator.
 */
export function nameKey(raw: string): string {
  return raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

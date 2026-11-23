// URL slug: lower case, accents dropped, one dash between words, none at the ends.
export function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

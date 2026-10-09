export function matchesCompletionName(name: string, search: string): boolean {
  const normalized = name.toLowerCase();
  let position = 0;
  for (const character of search.toLowerCase()) {
    position = normalized.indexOf(character, position);
    if (position < 0) return false;
    position++;
  }
  return true;
}

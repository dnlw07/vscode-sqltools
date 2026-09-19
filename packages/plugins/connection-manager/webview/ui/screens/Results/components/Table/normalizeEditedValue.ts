export function normalizeEditedValue(value: any, originalValue: any): any {
  if (originalValue === null && value === '') return null;

  if (typeof originalValue === 'number' && typeof value === 'string') {
    const normalized = value.trim();
    if (normalized !== '' && Number.isFinite(Number(normalized))) return Number(normalized);
  }

  if (typeof originalValue === 'boolean' && typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }

  return value;
}
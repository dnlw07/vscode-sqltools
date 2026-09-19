import { normalizeEditedValue } from './normalizeEditedValue';

describe('normalizeEditedValue', () => {
  it.each([
    ['', null, null],
    ['42', 42, 42],
    ['42.50', 42.5, 42.5],
    ['true', true, true],
    ['false', false, false],
  ])('normalizes %p against %p to %p', (value, original, expected) => {
    expect(normalizeEditedValue(value, original)).toBe(expected);
  });

  it.each([
    ['', 42],
    ['43', 42],
    ['changed', 'original'],
  ])('preserves a real edit from %p to %p', (value, original) => {
    expect(normalizeEditedValue(value, original)).toBe(value === '43' ? 43 : value);
  });
});
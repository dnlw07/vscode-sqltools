import formatDuration from './duration';

describe('formatDuration', () => {
  it.each([
    [999, '1sec'],
    [59_000, '59sec'],
    [63_000, '1min 3sec'],
    [60 * 60 * 1000, '1h'],
    [(60 + 32) * 60 * 1000, '1h 32min'],
  ])('formats %d milliseconds as %s', (milliseconds, expected) => {
    expect(formatDuration(milliseconds)).toBe(expected);
  });
});

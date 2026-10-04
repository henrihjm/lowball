import { describe, expect, it } from 'vitest';
import { decayStep, discardOutliers, dollars, median, parseFloorFromCaption, priceAtDay, proposePrice, roundTo5 } from '../src/policy/pricing.js';

describe('pricing', () => {
  it('rounds to the nearest $5', () => {
    expect(roundTo5(22_000)).toBe(22_000);
    expect(roundTo5(21_740)).toBe(21_500);
    expect(roundTo5(21_760)).toBe(22_000);
  });

  it('computes the median', () => {
    expect(median([300, 100, 200])).toBe(200);
    expect(median([100, 200, 300, 400])).toBe(250);
  });

  it('discards outliers outside 0.4x to 2.5x of the median', () => {
    expect(discardOutliers([20_000, 21_000, 19_000, 5_000, 90_000])).toEqual([20_000, 21_000, 19_000]);
  });

  it('ask is median * 1.10 and floor is median * 0.75, rounded to 5', () => {
    const p = proposePrice([18_000, 20_000, 22_000]);
    expect(p).toMatchObject({ ok: true, askCents: 22_000, floorCents: 15_000, n: 3 });
  });

  it('a caption floor overrides the computed floor', () => {
    const p = proposePrice([18_000, 20_000, 22_000], 16_000);
    expect(p).toMatchObject({ ok: true, askCents: 22_000, floorCents: 16_000 });
  });

  it('never invents a price from fewer than 3 comps', () => {
    expect(proposePrice([20_000, 21_000])).toEqual({ ok: false, reason: 'too_few_comps', n: 2 });
    expect(proposePrice([20_000, 21_000, 900_000])).toMatchObject({ ok: false });
  });

  it('decays 7% every 3 days and stops at the floor', () => {
    const p = { askCents: 22_000, floorCents: 16_000, decayPct: 7, decayEveryDays: 3 };
    expect(priceAtDay(p, 0)).toBe(22_000);
    expect(priceAtDay(p, 2)).toBe(22_000);
    expect(priceAtDay(p, 3)).toBe(20_500);
    expect(priceAtDay(p, 6)).toBe(19_000);
    expect(priceAtDay(p, 15)).toBe(16_000);
    expect(priceAtDay(p, 300)).toBe(16_000);
  });

  it('a decay step never goes below the floor', () => {
    expect(decayStep(22_000, 16_000, 7)).toBe(20_500);
    expect(decayStep(16_500, 16_000, 7)).toBe(16_000);
    expect(decayStep(16_000, 16_000, 7)).toBe(16_000);
  });

  it('reads "floor 150" from a caption', () => {
    expect(parseFloorFromCaption('Sayl chair, one arm loose. floor 150')).toBe(15_000);
    expect(parseFloorFromCaption('floor $160')).toBe(16_000);
    expect(parseFloorFromCaption('nice hardwood floor')).toBeUndefined();
    expect(parseFloorFromCaption(undefined)).toBeUndefined();
  });

  it('formats dollars', () => {
    expect(dollars(16_000)).toBe('$160');
    expect(dollars(16_050)).toBe('$160.50');
  });
});

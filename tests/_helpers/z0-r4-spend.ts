// Round 3's recorded spend by arm and sequence, and the plan cells, that the round 4 budget tests share.
import { DESIGNS } from '../../scripts/token-eval/arms.mjs';
import { money } from '../../scripts/token-eval/z0-budget.mjs';

// Round 3's recorded spend by arm and by batch 1 sequence (r3-bases.py on the round 3 run), unrounded.
export const BASIS = { A0: 314.93659099999996, A1: 386.4545920000009, A2: 385.2113900000005, A4: 256.7379992000001, A5: 373.4189512000002 };
export const SEQ = {
  q12: { A0: 23.390040399999993, A1: 31.0537406, A2: 27.276879600000004, A4: 21.507720200000005, A5: 25.7946444 },
  q14: { A0: 6.299849600000002, A1: 8.908169000000001, A2: 8.9157628, A4: 4.874098600000001, A5: 8.036368399999999 },
  q140: { A0: 12.632800200000002, A1: 12.9875568, A2: 13.336087199999998, A4: 8.9711754, A5: 13.4532806 },
  q145: { A0: 1.7979228000000003, A1: 1.0015326, A2: 1.2296926000000001, A4: 1.8101713999999998, A5: 1.7773954 },
  q184: { A0: 7.272139400000002, A1: 8.829888200000003, A2: 8.913826, A4: 5.6796945999999995, A5: 8.950295200000003 },
  q190: { A0: 8.991719199999999, A1: 10.146631600000001, A2: 11.240961999999998, A4: 7.870867800000001, A5: 10.227016999999998 },
  q212: { A0: 12.3443082, A1: 15.6111226, A2: 15.932155599999998, A4: 9.772375799999999, A5: 15.209025400000002 },
  q222: { A0: 6.994181, A1: 9.908843399999999, A2: 9.404470600000002, A4: 5.367052199999999, A5: 10.102072399999999 },
  q226: { A0: 8.415646, A1: 9.394431800000003, A2: 10.121354799999999, A4: 5.976598000000001, A5: 10.433823600000004 },
  q238: { A0: 7.886454799999999, A1: 8.901907, A2: 9.308398000000004, A4: 6.080827799999999, A5: 8.855432400000002 },
};
export const BATCH2_SEQ = { qa: { A0: 30, A1: 40, A2: 40, A4: 20, A5: 40 }, qb: { A0: 20, A1: 30, A2: 30, A4: 10, A5: 30 }, qc: { A0: 10, A1: 20, A2: 20, A4: 5, A5: 20 } };
export const MEAN = 0.3449386223427768;
export const BATCH1 = Object.keys(SEQ);
export const BATCH2 = Object.keys(BATCH2_SEQ);
export const cents = (x: number): string => money(x);
const sum = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0);
export const rule = (n: number) => ({ O1: n, S1: n, S2: n, S5: n });
export const sumsOver = (table: Record<string, Record<string, number>>, keys: readonly string[]) => Object.fromEntries(Object.keys(BASIS).map((a) => [a, sum(keys.map((k) => table[k]![a]!))]));

/** `n` plan cells over the arms listed, in the runner's plan.json shape. */
export const plan = (n: number, arms: readonly string[]) => Array.from({ length: n }, (_, i) => ({ seed: 1, position: i + 1, arm: arms[i % arms.length]!, sequence: 's', taskId: `t${i}`, repo: 'r', kind: 'apply', familyId: 'f', set: 'R' }));
export const ALL_ARMS: readonly string[] = DESIGNS.r4.arms;

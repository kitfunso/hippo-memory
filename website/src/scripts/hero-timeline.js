export const CYCLE = 12;
export const STILL_T = 9;
export const dayAt = (t) => ((t % CYCLE) < 4.4 ? 'monday' : 'tuesday');

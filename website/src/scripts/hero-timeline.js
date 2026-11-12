// The hero loop's clock, shared by the build-time renderer and the page that plays its video.
export const CYCLE = 12;
// The poster and the video's first frame: Tuesday, the card back up.
export const STILL_T = 9;
// Monday: the card is written, then filed. Tuesday: the drawer opens and the card comes back up.
export const dayAt = (t) => ((t % CYCLE) < 4.4 ? 'monday' : 'tuesday');

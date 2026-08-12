/**
 * Arcadia group meditation sessions.
 *
 * Sessions start every 15 minutes on the quarter hour - :00, :15, :30, :45 -
 * rather than "N minutes from whenever the server booted". That is worth doing
 * for a reason beyond tidiness: the schedule is a pure function of wall-clock
 * time, so a client can compute the next session itself. Countdowns are correct
 * before joining a room, survive a reconnect, and cannot drift apart between
 * server restarts or across several room instances.
 */

export const SESSION_INTERVAL_MIN = 15;

/** Meditations run 7-12 minutes; duration comes from the audio, not the clock. */
export const MEDITATIONS = [
  { file: "arcadia-01.mp3", title: "Settling",        duration: 7 * 60 },
  { file: "arcadia-02.mp3", title: "Open Water",      duration: 9 * 60 },
  { file: "arcadia-03.mp3", title: "The Long Garden", duration: 12 * 60 },
  { file: "arcadia-04.mp3", title: "Returning",       duration: 8 * 60 },
];

/** Epoch ms of the first quarter-hour boundary strictly after `now`. */
export function nextSessionAt(now = Date.now()) {
  const ms = SESSION_INTERVAL_MIN * 60 * 1000;
  return Math.floor(now / ms) * ms + ms;
}

/**
 * Which meditation plays at a given start time.
 *
 * Derived from the slot number rather than a counter on the room, so every room
 * instance - and every client - independently agrees on what is playing next
 * without needing to be told.
 */
export function meditationFor(startAt) {
  const slot = Math.floor(startAt / (SESSION_INTERVAL_MIN * 60 * 1000));
  return MEDITATIONS[slot % MEDITATIONS.length];
}

/**
 * Arcadia bonus: what you brought, multiplied by who sat with you.
 *
 * `others` deliberately excludes the player. The old build counted the player
 * themselves toward the group multiplier, which was marked in the source as a
 * testing shortcut - it meant meditating alone still paid a "group" bonus, and
 * the reward for a second person arriving was the same as for the first.
 */
export const GROUP_BONUS_PER_PERSON = 0.20;   // +20% per other finisher
export const GROUP_BONUS_CAP = 2.00;          // ceiling, so a full room is not a jackpot

export function arcadiaBonus(ownScore, others) {
  const group = Math.min(others * GROUP_BONUS_PER_PERSON, GROUP_BONUS_CAP);
  return {
    others,
    groupMultiplier: group,
    ownScore,
    // Own score is the base; the group multiplies what you actually brought,
    // so sitting in the circle contributing nothing earns nothing.
    awarded: Math.round(ownScore * (1 + group)),
  };
}

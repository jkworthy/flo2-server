import { schema, MapSchema } from "@colyseus/schema";

/**
 * Open-area presence.
 *
 * Position is continuous again, which brings back the validation that node ids
 * made unnecessary. What does *not* come back is player collision: avatars pass
 * through each other, so blocking a doorway or crowding someone is impossible
 * by construction rather than discouraged by a rule. That was the one property
 * worth keeping from the node build, and it survives free movement intact.
 */
export const Player = schema({
  x: "number",
  y: "number",
  heading: "number",          // body facing, radians
  speed: "number",            // metres per second, drives the walk animation
  area: "string",             // which area they are in; "gate" is the open one

  isMeditating: "boolean",
  seat: "number",             // seat index when in a hall, -1 when not seated
  xenSensorConnected: "boolean",
  xenScore: "number",

  playerId: "string",
  firebaseUid: "string",
  displayName: "string",

  avatarBody: "string",
  avatarHair: "string",
  avatarOutfit: "string",
  skinTone: "string",
  hairColor: "string",
});

export const ArcadiaState = schema({
  players: { map: Player, default: new MapSchema() },

  sessionActive: "boolean",
  sessionStartedAt: "number",
  sessionEndsAt: "number",
  nextSessionAt: "number",
  meditationFile: "string",
  meditationTitle: "string",
  participantCount: "number",
});

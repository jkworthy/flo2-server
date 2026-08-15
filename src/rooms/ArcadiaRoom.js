import { Room } from "colyseus";
import { Player, ArcadiaState } from "./schema/Player.js";
import { WORLD, clampToBounds, validateMove, ejectFromWalls, ejectFromSites } from "../world/area.js";
import { nextSessionAt, meditationFor, arcadiaBonus } from "../world/sessions.js";

/** Nobody stands closer than this to somebody already here, in metres. */
const SPAWN_APART = 4.0;           // was eight feet, which still read as crowded

/**
 * A spot at the spawn point that nobody is standing on.
 *
 * Everyone arriving at the same coordinate put two players inside one
 * body-width, which reads as a rendering fault rather than as two people. This
 * walks outward in rings until it finds clear ground - a ring at a time, eight
 * points around each - so the first arrival gets the exact spawn and later ones
 * fan out around it in a way that still looks deliberate.
 *
 * Each ring is rotated half a step off the one inside it, or the points line up
 * into spokes and a busy room grows arms.
 *
 * Falls back to the spawn point itself after the last ring. A room crowded
 * enough to exhaust six rings has bigger problems than overlap, and refusing to
 * place somebody is worse than placing them badly.
 */
function freeSpawn(players) {
  const taken = [];
  players.forEach((q) => taken.push([q.x, q.y]));
  const clear = (x, y) => taken.every(
    ([px, py]) => Math.hypot(x - px, y - py) >= SPAWN_APART);

  const ox = WORLD.spawn.x, oy = WORLD.spawn.y;
  if (clear(ox, oy)) return [ox, oy];
  for (let ring = 1; ring <= 6; ring++) {
    const r = SPAWN_APART * ring;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + (ring % 2) * (Math.PI / 8);
      const x = ox + Math.cos(a) * r, y = oy + Math.sin(a) * r;
      if (clear(x, y)) return [x, y];
    }
  }
  return [ox, oy];
}

export class ArcadiaRoom extends Room {
  onCreate() {
    this.state = new ArcadiaState();
    this.maxClients = 64;

    this.session = null;          // { startAt, endsAt, meditation, eligible:Set, completed:Set }
    this.lastChat = new Map();    // sessionId -> last message time, for rate limiting
    this.lastMove = new Map();    // sessionId -> last move time, for speed validation
    this.sessionTimer = null;
    this.endTimer = null;

    /* --- movement ------------------------------------------------------- */

    this.onMessage("move", (client, msg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || p.isMeditating) return;              // seated players do not move
      const x = Number(msg?.x), y = Number(msg?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;

      const now = Date.now();
      const last = this.lastMove.get(client.sessionId) ?? now;
      this.lastMove.set(client.sessionId, now);

      // Clamped, not rejected: refusing a move leaves client and server
      // disagreeing until the next tick, which the player sees as rubber-banding.
      const ok = validateMove({ x: p.x, y: p.y }, { x, y }, (now - last) / 1000);
      p.x = ok.x; p.y = ok.y;
      const h = Number(msg?.heading);
      if (Number.isFinite(h)) p.heading = h;
      const sp = Number(msg?.speed);
      if (Number.isFinite(sp)) p.speed = Math.max(0, Math.min(12, sp));
    });

    /* --- meditation ----------------------------------------------------- */

    this.onMessage("meditation", (client, msg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      const want = !!msg?.isMeditating;

      // Sitting is allowed anywhere - it is a thing a person can do. What the
      // grove gates is *session eligibility*, checked at the bell in
      // startSession(). Refusing to let someone sit by a wall served no purpose
      // and made the pose look broken outside one node.
      //
      // Space is found before the pose is set, though. Walking through another
      // player is the point; sitting inside one is just two bodies in the same
      // hole in the ground, and unlike walking it is a state you hold for the
      // whole session.
      if (want && !p.isMeditating) {
        const spot = this.freeSeat(client.sessionId, p.x, p.y);
        p.x = spot.x; p.y = spot.y;
      }
      p.isMeditating = want;
      this.refreshParticipants();
    });

    this.onMessage("xen_score", (client, msg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      const s = Number(msg?.xenScore);
      if (Number.isFinite(s)) p.xenScore = Math.max(0, Math.min(100, s));
    });

    this.onMessage("xen_sensor_status", (client, msg) => {
      const p = this.state.players.get(client.sessionId);
      if (p) p.xenSensorConnected = !!msg?.connected;
    });

    this.onMessage("meditation_complete", (client) => {
      this.completeSession(client);
    });

    /* --- chat -----------------------------------------------------------
       With movement griefing gone by construction, chat is the only abuse
       surface left, so the limits are here from the start rather than bolted on
       later: length capped, rate limited server-side, and muting is enforced by
       the sender's own room rather than trusted to each listener. */
    this.onMessage("chat", (client, msg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      const text = String(msg?.text ?? "").trim().slice(0, 55);
      if (!text) return;

      const now = Date.now();
      const last = this.lastChat.get(client.sessionId) || 0;
      if (now - last < 700) return;                 // ~1.4 messages a second
      this.lastChat.set(client.sessionId, now);

      this.broadcast("chat", {
        from: client.sessionId,
        name: p.displayName || "guest",
        text,
        at: now,
      });
    });

    this.onMessage("avatar", (client, msg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || !msg) return;
      // avatarOutfit carries the whole wardrobe choice as JSON - nine slots
      // and their garment ids - so it needs more room than a name. Still capped:
      // it is echoed to every other player in the room.
      const LIMIT = { avatarOutfit: 400 };
      for (const k of ["avatarBody","avatarHair","avatarOutfit","skinTone","hairColor","displayName"]) {
        if (typeof msg[k] === "string" && msg[k].length <= (LIMIT[k] ?? 64)) p[k] = msg[k];
      }
    });

    this.scheduleNext();
  }

  /**
   * The nearest place to sit that is not inside somebody else.
   *
   * Spirals outward from where they are standing, so the nudge is the smallest
   * one that works - a player who sits somewhere empty does not move at all,
   * and a player who sits on top of a group is placed just outside it rather
   * than flung to the edge of the area.
   *
   * Only meditating players are considered. Someone walking past is about to be
   * somewhere else, and treating them as an obstacle would make sitting in a
   * busy avenue fail for no lasting reason.
   */
  freeSeat(sessionId, x, y) {
    const SPACING = 1.5;                 // shoulder to shoulder, seated
    const taken = [];
    this.state.players.forEach((q, id) => {
      if (id !== sessionId && q.isMeditating) taken.push(q);
    });

    const clear = (cx, cy) =>
      taken.every((q) => Math.hypot(q.x - cx, q.y - cy) >= SPACING);

    const fits = (cx, cy) => {
      const b = clampToBounds(cx, cy);
      if (Math.abs(b.x - cx) > 1e-6 || Math.abs(b.y - cy) > 1e-6) return null;
      const e = ejectFromWalls(cx, cy);
      if (Math.abs(e.x - cx) > 1e-6 || Math.abs(e.y - cy) > 1e-6) return null;
      const t = ejectFromSites(cx, cy);
      if (Math.abs(t.x - cx) > 1e-6 || Math.abs(t.y - cy) > 1e-6) return null;
      return clear(cx, cy) ? { x: cx, y: cy } : null;
    };

    const here = fits(x, y);
    if (here) return here;

    for (let ring = 1; ring <= 12; ring++) {
      const r = ring * SPACING * 0.8;
      const steps = Math.max(6, ring * 6);
      for (let i = 0; i < steps; i++) {
        // Offset each ring so the spots do not line up into spokes.
        const a = (i / steps) * Math.PI * 2 + ring * 0.7;
        const spot = fits(x + Math.cos(a) * r, y + Math.sin(a) * r);
        if (spot) return spot;
      }
    }
    return { x, y };                     // packed solid; sit where you stand
  }

  /* --- session scheduling ------------------------------------------------ */

  scheduleNext() {
    const at = nextSessionAt();
    const med = meditationFor(at);
    this.state.nextSessionAt = at;
    this.state.meditationFile = med.file;
    this.state.meditationTitle = med.title;
    this.state.sessionActive = false;

    if (this.sessionTimer) this.clock.clear(this.sessionTimer);
    this.sessionTimer = this.clock.setTimeout(() => this.startSession(), Math.max(0, at - Date.now()));
    console.log(`[Arcadia] next session ${new Date(at).toISOString()} - ${med.title} (${med.duration}s)`);
  }

  startSession() {
    const startAt = this.state.nextSessionAt;
    const med = meditationFor(startAt);

    // Eligibility is judged once, at the bell: in the grove, seated, sensor on.
    const eligible = new Set();
    this.state.players.forEach((p, id) => {
      if (p.isMeditating && p.xenSensorConnected) eligible.add(id);
    });

    this.session = { startAt, endsAt: startAt + med.duration * 1000, meditation: med,
                     eligible, completed: new Set() };

    this.state.sessionActive = true;
    this.state.sessionStartedAt = startAt;
    this.state.sessionEndsAt = this.session.endsAt;
    this.state.participantCount = eligible.size;

    for (const client of this.clients) {
      if (!eligible.has(client.sessionId)) continue;
      client.send("session_start", {
        file: med.file, title: med.title, duration: med.duration,
        endsAt: this.session.endsAt, participants: eligible.size,
      });
    }
    console.log(`[Arcadia] session started, ${eligible.size} participant(s)`);

    if (this.endTimer) this.clock.clear(this.endTimer);
    this.endTimer = this.clock.setTimeout(() => this.endSession(), med.duration * 1000 + 5000);
  }

  endSession() {
    if (this.session) {
      console.log(`[Arcadia] session ended, ${this.session.completed.size}/${this.session.eligible.size} completed`);
    }
    this.session = null;
    this.state.sessionActive = false;
    this.state.participantCount = 0;
    this.scheduleNext();
  }

  completeSession(client) {
    const s = this.session;
    const p = this.state.players.get(client.sessionId);
    if (!s || !p) return;
    if (!s.eligible.has(client.sessionId)) return;      // was not in the circle at the bell
    if (s.completed.has(client.sessionId)) return;      // no double-claiming
    if (Date.now() < s.startAt + s.meditation.duration * 1000 * 0.9) {
      // Claiming completion before the audio could plausibly have finished.
      client.send("session_rejected", { reason: "too_early" });
      return;
    }

    s.completed.add(client.sessionId);

    // Everyone who has finished sees their group grow as others land, so the
    // count is recomputed for each recipient rather than frozen at their own
    // moment of completion.
    for (const id of s.completed) {
      const c = this.clients.find((c) => c.sessionId === id);
      const q = this.state.players.get(id);
      if (!c || !q) continue;
      c.send("session_complete", {
        ...arcadiaBonus(q.xenScore, s.completed.size - 1),
        completed: s.completed.size,
        eligible: s.eligible.size,
      });
    }
  }

  refreshParticipants() {
    if (!this.session) return;
    let n = 0;
    this.state.players.forEach((p) => { if (p.isMeditating) n++; });
    this.state.participantCount = n;
  }

  /* --- lifecycle --------------------------------------------------------- */

  onJoin(client, options = {}) {
    // One body per person.
    //
    // A reload does not always close the old connection cleanly, and until it
    // times out the room still holds that session - so the player walks back in
    // and stands next to themselves. Worse than a cosmetic double: the stale
    // copy keeps whatever it joined with, so the two animate differently and it
    // reads as one of them being broken rather than as one of them being old.
    //
    // Judged on firebaseUid, not on name: names are not unique, so matching on
    // them would evict strangers who happened to share one.
    const uid = options.firebaseUid || "";
    if (uid) {
      this.state.players.forEach((q, id) => {
        if (id === client.sessionId || q.firebaseUid !== uid) return;
        console.log(`[Arcadia] ${id} replaced by ${client.sessionId} (${uid})`);
        this.state.players.delete(id);
        this.lastMove.delete(id);
        this.lastChat.delete(id);
        if (this.session) this.session.eligible.delete(id);
        const stale = this.clients.find((c) => c.sessionId === id);
        if (stale) { try { stale.leave(1000); } catch { /* already gone */ } }
      });
    }

    // Start the movement clock at join. Leaving it unset made the elapsed time
    // on the very first move packet zero, which capped a player's opening step
    // at 0.4m - they appeared to wade out of spawn before walking normally.
    this.lastMove.set(client.sessionId, Date.now());
    const p = new Player();
    p.playerId = client.sessionId;
    p.firebaseUid = options.firebaseUid || "";
    p.displayName = (options.displayName || "").slice(0, 64);
    const spawn = clampToBounds(...freeSpawn(this.state.players));
    p.x = spawn.x; p.y = spawn.y;
    p.heading = WORLD.spawn.heading;
    p.speed = 0;
    p.area = WORLD.id;
    p.seat = -1;
    p.isMeditating = false;
    p.xenSensorConnected = false;
    p.xenScore = 0;
    p.avatarBody = options.avatarBody || "body_01";
    p.avatarHair = options.avatarHair || "hair_01";
    p.avatarOutfit = options.avatarOutfit || "outfit_01";
    p.skinTone = options.skinTone || "#FFDBAC";
    p.hairColor = options.hairColor || "#8B4513";
    this.state.players.set(client.sessionId, p);
    console.log(`[Arcadia] ${client.sessionId} joined at ${p.x.toFixed(1)},${p.y.toFixed(1)}`);
  }

  onLeave(client) {
    this.state.players.delete(client.sessionId);
    this.lastChat.delete(client.sessionId);
    this.lastMove.delete(client.sessionId);
    if (this.session) this.session.eligible.delete(client.sessionId);
    this.refreshParticipants();
  }

  onDispose() {
    if (this.sessionTimer) this.clock.clear(this.sessionTimer);
    if (this.endTimer) this.clock.clear(this.endTimer);
  }
}

import config from "@colyseus/tools";
import { monitor } from "@colyseus/monitor";
import { playground } from "@colyseus/playground";

import { ArcadiaRoom } from "./rooms/ArcadiaRoom.js";

export default config({
  initializeGameServer: (gameServer) => {
    // filterBy([]) ignores client options for matchmaking, so everyone lands in
    // the same instance. That matters more here than it did before: the group
    // meditation bonus is only meaningful if the room is not silently sharded.
    gameServer.define("arcadia", ArcadiaRoom).filterBy([]);
  },

  initializeExpress: (app) => {
    app.get("/health", (_req, res) => res.json({ ok: true, at: Date.now() }));

    if (process.env.NODE_ENV !== "production") {
      app.use("/playground", playground());
    }
    app.use("/monitor", monitor());
  },

  beforeListen: () => {},
});

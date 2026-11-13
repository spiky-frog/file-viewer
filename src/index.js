
import { DurableObject } from "cloudflare:workers";

// Main Cloudflare Worker
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Existing health check
    if (url.pathname === "/api/health") {
      return Response.json({
        status: "ok",
        service: "file-viewer"
      });
    }

    // Test communication with our Durable Object
    if (url.pathname === "/api/room-health") {
      try {
        const room = env.PAIRING_ROOM.getByName("health-check");

        const result = await room.checkHealth();

        return Response.json(result);
      } catch (error) {
        console.error("Durable Object health check failed", error);

        return Response.json(
          { status: "error", message: "Room unavailable" },
          { status: 500 }
        );
      }
    }

    return new Response("Not Found", {
      status: 404
    });
  }
};

// Durable Object for device pairing
export class PairingRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
  }

  async checkHealth() {
    return {
      status: "ok",
      service: "pairing-room"
    };
  }
}

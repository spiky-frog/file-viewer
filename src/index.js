
import { DurableObject } from "cloudflare:workers";

const SESSION_DURATION = 10 * 60 * 1000;

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);

  return Array.from(bytes, byte =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

async function hashToken(token) {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(digest), byte =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

// Main Cloudflare Worker
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({
        status: "ok",
        service: "file-viewer"
      });
    }

    if (url.pathname === "/api/room-health") {
      try {
        const room = env.PAIRING_ROOM.getByName("health-check");
        return Response.json(await room.checkHealth());
      } catch (error) {
        console.error("Room health check failed", error);

        return Response.json(
          { status: "error", message: "Room unavailable" },
          { status: 500 }
        );
      }
    }

    // Create a temporary pairing session
    if (url.pathname === "/api/sessions") {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { Allow: "POST" }
        });
      }

      // Only allow requests originating from our website
      if (request.headers.get("Origin") !== url.origin) {
        return new Response("Forbidden", { status: 403 });
      }

      try {
        const sessionId = crypto.randomUUID();
        const pairingToken = randomToken();
        const tokenHash = await hashToken(pairingToken);
        const expiresAt = Date.now() + SESSION_DURATION;

        const room = env.PAIRING_ROOM.getByName(sessionId);

        await room.createSession(tokenHash, expiresAt);

        return Response.json(
          { sessionId, pairingToken, expiresAt },
          {
            status: 201,
            headers: {
              "Cache-Control": "no-store"
            }
          }
        );
      } catch (error) {
        console.error("Session creation failed", error);

        return Response.json(
          { error: "Could not create session" },
          { status: 500 }
        );
      }
    }

    return new Response("Not Found", { status: 404 });
  }
};

// Durable Object for each pairing session
export class PairingRoom extends DurableObject {
  async checkHealth() {
    return {
      status: "ok",
      service: "pairing-room"
    };
  }

  async createSession(tokenHash, expiresAt) {
    // Save session details in the room's private storage
    await this.ctx.storage.put("session", {
      tokenHash,
      expiresAt,
      joined: false
    });

    // Schedule automatic cleanup
    await this.ctx.storage.setAlarm(expiresAt);

    return { created: true };
  }

  async alarm() {
    // Delete the expired session's stored data
    await this.ctx.storage.deleteAll();
  }
}

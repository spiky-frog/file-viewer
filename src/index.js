
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Basic health check
    if (url.pathname === "/api/health") {
      return Response.json({
        status: "ok",
        service: "file-viewer"
      });
    }

    // Durable Object health check
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

    // Require requests from our website for session operations
    if (url.pathname.startsWith("/api/sessions")) {
      if (request.headers.get("Origin") !== url.origin) {
        return new Response("Forbidden", { status: 403 });
      }
    }

    // Create pairing session
    if (url.pathname === "/api/sessions") {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", {
          status: 405
        });
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
            headers: { "Cache-Control": "no-store" }
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

    // Join an existing session
    const joinMatch = url.pathname.match(
      /^\/api\/sessions\/([0-9a-f-]{36})\/join$/
    );

    if (joinMatch) {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", {
          status: 405
        });
      }

      try {
        const body = await request.json();
        const token = body?.pairingToken;

        if (
          typeof token !== "string" ||
          !/^[0-9a-f]{64}$/.test(token)
        ) {
          return Response.json(
            { error: "Invalid pairing request" },
            { status: 400 }
          );
        }

        const sessionId = joinMatch[1];
        const tokenHash = await hashToken(token);

        const room = env.PAIRING_ROOM.getByName(sessionId);
        const result = await room.joinSession(tokenHash);

        if (!result.success) {
          return Response.json(
            { error: "Invalid or unavailable session" },
            {
              status: 403,
              headers: { "Cache-Control": "no-store" }
            }
          );
        }

        return Response.json(
          { success: true, message: "Device paired" },
          { headers: { "Cache-Control": "no-store" } }
        );

      } catch (error) {
        console.error("Join request failed", error);
        return Response.json(
          { error: "Invalid pairing request" },
          { status: 400 }
        );
      }
    }

    return new Response("Not Found", { status: 404 });
  }
};

export class PairingRoom extends DurableObject {
  async checkHealth() {
    return {
      status: "ok",
      service: "pairing-room"
    };
  }

  async createSession(tokenHash, expiresAt) {
    await this.ctx.storage.put("session", {
      tokenHash,
      expiresAt,
      joined: false,
      failedAttempts: 0
    });

    await this.ctx.storage.setAlarm(expiresAt);
    return { created: true };
  }

  async joinSession(tokenHash) {
    const session = await this.ctx.storage.get("session");

    if (!session || Date.now() >= session.expiresAt) {
      return { success: false };
    }

    // Only one phone can join
    if (session.joined) {
      return { success: false };
    }

    // Limit incorrect pairing attempts
    if ((session.failedAttempts || 0) >= 10) {
      return { success: false };
    }

    if (session.tokenHash !== tokenHash) {
      session.failedAttempts =
        (session.failedAttempts || 0) + 1;

      await this.ctx.storage.put("session", session);
      return { success: false };
    }

    // Mark the session as paired
    session.joined = true;
    await this.ctx.storage.put("session", session);

    return { success: true };
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}

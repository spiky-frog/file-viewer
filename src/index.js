
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

        // Separate credentials for each device
        const ownerToken = randomToken();
        const pairingToken = randomToken();
        
        const ownerHash = await hashToken(ownerToken);
        const tokenHash = await hashToken(pairingToken);
        
        const expiresAt = Date.now() + SESSION_DURATION;
        
        const room = env.PAIRING_ROOM.getByName(sessionId);
        
        await room.createSession(
          tokenHash,
          expiresAt,
          ownerHash
        );
        
        return Response.json(
          { sessionId, ownerToken, pairingToken, expiresAt },
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
    
    // Connect computer to its pairing room via WebSocket
    const wsMatch = url.pathname.match(
      /^\/api\/sessions\/([0-9a-f-]{36})\/ws$/
    );

    if (wsMatch) {
      if (
        request.method !== "GET" ||
        request.headers.get("Upgrade")?.toLowerCase()
          !== "websocket"
      ) {
        return new Response("WebSocket upgrade required", {
          status: 426
        });
      }

      const protocols = (
        request.headers.get("Sec-WebSocket-Protocol") || ""
      ).split(",").map(value => value.trim());

      if (
        protocols.length !== 2 ||
        protocols[0] !== "file-viewer" ||
        !/^token\.[0-9a-f]{64}$/.test(protocols[1])
      ) {
        return new Response("Unauthorized", { status: 401 });
      }

      const room = env.PAIRING_ROOM.getByName(wsMatch[1]);

      return room.fetch(request);
    }

    // Check whether a phone has joined the session
    const statusMatch = url.pathname.match(
      /^\/api\/sessions\/([0-9a-f-]{36})\/status$/
    );

    if (statusMatch) {
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
            { error: "Invalid request" },
            { status: 400 }
          );
        }

        const tokenHash = await hashToken(token);

        const room = env.PAIRING_ROOM.getByName(
          statusMatch[1]
        );

        const result = await room.getSessionStatus(tokenHash);

        if (!result) {
          return Response.json(
            { error: "Session unavailable" },
            { status: 403 }
          );
        }

        return Response.json(result, {
          headers: { "Cache-Control": "no-store" }
        });

      } catch (error) {
        console.error("Status check failed", error);

        return Response.json(
          { error: "Could not check session" },
          { status: 400 }
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
  
  async fetch(request) {
    const protocols = (
      request.headers.get("Sec-WebSocket-Protocol") || ""
    ).split(",").map(value => value.trim());

    if (
      request.headers.get("Upgrade")?.toLowerCase()
        !== "websocket" ||
      protocols.length !== 2 ||
      protocols[0] !== "file-viewer" ||
      !/^token\.[0-9a-f]{64}$/.test(protocols[1])
    ) {
      return new Response("Unauthorized", { status: 401 });
    }

    const tokenHash = await hashToken(
      protocols[1].slice("token.".length)
    );

    const session = await this.ctx.storage.get("session");

    if (
      !session ||
      Date.now() >= session.expiresAt ||
      session.ownerHash !== tokenHash
    ) {
      return new Response("Session unavailable", {
        status: 403
      });
    }

    // Allow only one computer WebSocket per session.
    if (this.ctx.getWebSockets("computer").length > 0) {
      return new Response("Computer already connected", {
        status: 409
      });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server, ["computer"]);

    server.send(JSON.stringify({
      type: "session-status",
      joined: session.joined
    }));

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: {
        "Sec-WebSocket-Protocol": "file-viewer"
      }
    });
  }

  async webSocketMessage(ws, message) {
    // File-transfer signalling will be added later.
  }

  async checkHealth() {
    return {
      status: "ok",
      service: "pairing-room"
    };
  }

  async createSession(tokenHash, expiresAt, ownerHash) {
    await this.ctx.storage.put("session", {
      tokenHash,
      ownerHash,
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

    // Notify the connected computer immediately.
    for (const ws of this.ctx.getWebSockets("computer")) {
      try {
        ws.send(JSON.stringify({
          type: "phone-joined"
        }));
      } catch (error) {
        console.error("WebSocket notification failed", error);
      }
    }

    return { success: true };

  }

  async getSessionStatus(tokenHash) {
    const session = await this.ctx.storage.get("session");

    if (!session) {
      return null;
    }

    if (Date.now() >= session.expiresAt) {
      return null;
    }

    if (session.ownerHash !== tokenHash) {
      return null;
    }

    return {
      joined: session.joined,
      expiresAt: session.expiresAt
    };
  }

  async alarm() {
    // Close all WebSocket connections in this room.
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1000, "Pairing session expired");
      } catch (error) {
        console.error("Could not close WebSocket:", error);
      }
    }

    // Delete the expired pairing session.
    await this.ctx.storage.deleteAll();
  }
}

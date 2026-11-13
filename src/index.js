
import { DurableObject } from "cloudflare:workers";

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

  async fetch(request) {
    return Response.json({
      status: "ok",
      service: "pairing-room"
    });
  }
}

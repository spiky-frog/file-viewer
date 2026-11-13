
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

import { onRequestPost as genererPost } from "../generate.js";

export default {
    async fetch(request, env) {
          const url = new URL(request.url);
          if (url.pathname === "/api/generate" && request.method === "POST") {
                  return genererPost({ request, env });
          }
          return env.ASSETS.fetch(request);
    },
};

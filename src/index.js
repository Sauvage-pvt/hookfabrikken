import { onRequestPost as genererPost } from "../generate.js";
import { onRequestGet as statsGet } from "../stats.js";

export default {
        async fetch(request, env) {
                    const url = new URL(request.url);
                    if (url.pathname === "/api/generate" && request.method === "POST") {
                                    return genererPost({ request, env });
                    }
                    if (url.pathname === "/api/stats" && request.method === "GET") {
                                    return statsGet({ request, env });
                    }
                    return env.ASSETS.fetch(request);
        },
};

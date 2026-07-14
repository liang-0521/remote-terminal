import { readFile } from "node:fs/promises";
import path from "node:path";

const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function response(status, body, contentType = "text/plain; charset=utf-8") {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function registerAppProtocol(protocol, distRoot) {
  const root = path.resolve(distRoot);
  protocol.handle("app", async (request) => {
    if (!["GET", "HEAD"].includes(request.method)) return response(405, "Method Not Allowed");
    const url = new URL(request.url);
    if (url.host !== "renderer") return response(403, "Forbidden");

    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return response(400, "Bad Request");
    }
    const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const absolutePath = path.resolve(root, relativePath);
    if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) {
      return response(403, "Forbidden");
    }

    try {
      const body = request.method === "HEAD" ? null : await readFile(absolutePath);
      const contentType = CONTENT_TYPES.get(path.extname(absolutePath).toLowerCase()) || "application/octet-stream";
      return response(200, body, contentType);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "EISDIR") return response(404, "Not Found");
      return response(500, "Internal Server Error");
    }
  });
}

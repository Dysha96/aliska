// Entry point for Deno Deploy: serves the same skill handler that Vercel runs from api/index.js.
// Alice's servers are in Russia, where *.vercel.app names get blocked, while *.deno.dev is reachable.
import process from "node:process";

globalThis.process ??= process;
const { default: handler } = await import("./api/index.js");

Deno.serve(async request => {
  const url = new URL(request.url);
  if (url.pathname !== "/api" && url.pathname !== "/") {
    return new Response("Not found", { status: 404 });
  }

  const body = request.method === "POST" ? await request.json().catch(() => ({})) : undefined;
  const req = {
    method: request.method,
    url: url.pathname + url.search,
    query: Object.fromEntries(url.searchParams),
    body
  };

  // The handler is written for Vercel's (req, res) style; collect its answer into a Response.
  return new Promise(resolve => {
    const headers = new Headers();
    let status = 200;
    const res = {
      status(code) {
        status = code;
        return this;
      },
      setHeader(name, value) {
        headers.set(name, value);
      },
      json(value) {
        headers.set("Content-Type", "application/json; charset=utf-8");
        resolve(new Response(JSON.stringify(value), { status, headers }));
        return value;
      }
    };
    handler(req, res).catch(error => {
      console.error("Handler crashed:", error?.name);
      resolve(Response.json({ error: "Internal error" }, { status: 500 }));
    });
  });
});

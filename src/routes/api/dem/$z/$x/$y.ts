import { createFileRoute } from "@tanstack/react-router";

function tileIndex(value: string, max: number): number | null {
  if (!/^\d{1,6}$/.test(value)) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > max) return null;
  return n;
}

export const Route = createFileRoute("/api/dem/$z/$x/$y")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const z = tileIndex(params.z, 14);
        if (z == null) return new Response("bad zoom", { status: 400 });
        const limit = 2 ** z - 1;
        const x = tileIndex(params.x, limit);
        const y = tileIndex(params.y, limit);
        if (x == null || y == null) return new Response("bad tile", { status: 400 });
        const upstream = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`);
        if (!upstream.ok) return new Response("no elevation", { status: upstream.status });
        return new Response(upstream.body, {
          headers: {
            "Content-Type": "image/png",
            "Cache-Control": "public, max-age=604800",
          },
        });
      },
    },
  },
});

import raw from "@/lib/hunt/id-border.json";

const rings = raw.features[0]?.geometry.coordinates ?? [];

export const idBorder = {
  type: "FeatureCollection" as const,
  features: [
    {
      type: "Feature" as const,
      properties: { kind: "state" },
      geometry: { type: "Polygon" as const, coordinates: rings },
    },
  ],
};

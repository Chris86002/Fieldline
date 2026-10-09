import raw from "@/lib/hunt/az-border.json";

const rings = raw.features[0]?.geometry.coordinates ?? [];

export const azBorder = {
  type: "FeatureCollection" as const,
  features: [
    {
      type: "Feature" as const,
      properties: { kind: "state" },
      geometry: { type: "Polygon" as const, coordinates: rings },
    },
  ],
};

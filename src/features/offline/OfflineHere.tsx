import { useEffect, useState } from "react";
import { coverageAt, useOffline } from "./controller.ts";
import { coverageText } from "./model.ts";

/** Whether a spot is covered by a downloaded area, and at which zooms (FIELD-01). Hidden when nothing is downloaded. */
export function OfflineHere({ lng, lat }: { lng: number; lat: number }) {
  const packages = useOffline((s) => s.packages);
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    if (packages.length === 0) {
      setText(null);
      return;
    }
    void coverageAt({ lng, lat }).then((coverage) => {
      if (live) setText(coverageText(coverage, true));
    });
    return () => {
      live = false;
    };
  }, [lng, lat, packages]);

  return text ? <p className="mt-1 text-xs text-subtle">{text}</p> : null;
}

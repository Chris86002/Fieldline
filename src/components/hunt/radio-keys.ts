/**
 * Keyboard pattern for a radio group (WAI-ARIA APG "Radio Group"): arrow keys
 * move to the previous/next option and select it, wrapping at the ends; Home
 * and End go to the first and last. Returns the index to select, or null when
 * the key isn't one the group handles.
 */
export function radioKeyTarget(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  const current = index < 0 ? 0 : index;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return (current + 1) % count;
    case "ArrowLeft":
    case "ArrowUp":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** Roving tab stop: the selected option, or the first when none is selected. */
export function radioTabStop(selectedIndex: number, index: number): 0 | -1 {
  return index === (selectedIndex < 0 ? 0 : selectedIndex) ? 0 : -1;
}

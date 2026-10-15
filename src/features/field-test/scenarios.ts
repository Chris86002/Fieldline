/**
 * The 13 field-test scenarios from docs/phone-strategy.md (REL-03), with
 * short on-screen steps. Numbers must stay in step with that document and
 * docs/field-test-checklist.md, because reports are labelled by number.
 */
export type Scenario = {
  number: number;
  title: string;
  /** What to do during the run, in plain words. */
  steps: string;
  /** Suggested length, minutes (null: as long as the scenario takes). */
  minutes: number | null;
};

export const SCENARIOS: readonly Scenario[] = [
  { number: 1, title: "Screen on, app open", steps: "Start, then walk with the screen on and this page showing.", minutes: 30 },
  { number: 2, title: "Screen locked", steps: "Start, walk 2 minutes, lock the phone and keep walking 15 minutes, then unlock.", minutes: 20 },
  { number: 3, title: "Other app in front", steps: "Start, walk 2 minutes, switch to another app for 10 minutes while walking, then come back.", minutes: 15 },
  { number: 4, title: "Phone call", steps: "Start, walk, and take or make a call of a few minutes, then come back.", minutes: 10 },
  { number: 5, title: "Weak signal", steps: "Start, walk into dense trees, a canyon or a building, then back out.", minutes: 15 },
  { number: 6, title: "Location permission off", steps: "Start, then turn off location permission for the browser in phone Settings, come back.", minutes: 5 },
  { number: 7, title: "Battery saver", steps: "Turn on battery saver / Low Power Mode, then start and walk with the screen on.", minutes: 30 },
  { number: 8, title: "Phone storage nearly full", steps: "Only if storage is nearly full already. Start and walk.", minutes: 10 },
  { number: 9, title: "Airplane mode", steps: "Start, walk 2 minutes, turn on airplane mode (leave location on), walk 10 minutes, turn it off.", minutes: 15 },
  { number: 10, title: "App closed by force", steps: "Start, walk 5 minutes, swipe the browser away from the app switcher, reopen this page.", minutes: 10 },
  { number: 11, title: "Phone restart", steps: "Start, walk 5 minutes, restart the phone, reopen this page.", minutes: 10 },
  { number: 12, title: "Long session", steps: "Start and record for 4 hours or more, screen as you'd normally use it.", minutes: 240 },
  { number: 13, title: "App update", steps: "Not run in this tool: install a new build over one with saved marks and check they remain.", minutes: null },
];

export function scenarioByNumber(number: number): Scenario | null {
  return SCENARIOS.find((scenario) => scenario.number === number) ?? null;
}

/** The short first round that answers "is the PWA viable on this phone?" (see the checklist). */
export const FIRST_ROUND = [1, 2, 3, 9, 10, 4] as const;

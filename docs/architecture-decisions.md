# Architecture decisions

Short records of the approaches chosen while implementing
[the master spec](Fieldline-AI-Master-Implementation-Document.txt). Each entry
says what was decided, why, and what would make us revisit it. Status values:
**accepted** (in code), **proposed** (drafted, not yet built), **open** (needs
an owner decision).

## ADR-001 Versioned settings in their own key — accepted (2026-10-13)

**Decision.** User preferences live in a typed, validated `AppSettings` object
(`src/features/settings/schema.ts`) persisted under `fieldline-settings` with
`version: 1`. On first load with no settings saved, preferences migrate from
the fields `fieldline-v1` already stored. `fieldline-v1` is left exactly as it
was: its waypoints, tracks, and legacy preference fields keep their format, so
an older Fieldline build still opens the profile with its own preferences.

**Why.** The spec requires defaults, ranges, migration, per-category reset,
presets and import/export (§5) without risking saved content (§8, REL-08).
Keeping settings out of the content record means a settings reset or a bad
import can never touch marks or tracks, and the existing `version !== 0`
guard in `persistence.ts` keeps protecting content from newer schemas.

**Effective values.** defaults → user preferences → active preset (built-in
values plus the user's edits to that preset). Editing a setting the active
preset controls edits the preset, never the preference underneath. Session
overrides (e.g. automatic quality reductions) are not implemented yet; they
will be added with their first consumer (cloud quality, CC-10) and must show a
visible reason.

**Safety rules.** A corrupt `fieldline-settings` value or one with a newer
`version` is never overwritten: the app reads what it can, shows a warning,
and stops writing. Imports are validated field by field; invalid values are
rejected and reported, valid ones kept.

**Revisit when** content moves to IndexedDB (CC-05). Settings can stay in
localStorage; the backup format (CC-05) must include them.

## ADR-002 Unknown is a value — accepted (2026-10-13)

**Decision.** Provider answers keep "unknown" distinct from zero, empty and
failure. Weather measurements are `number | null` (`weather.ts`); land answers
are `record`, `no-record` (ownership unknown) or a thrown outage (`land.ts`).
Formatters render `null` as "—" and never substitute a default.

**Why.** Spec findings D and E: a missing polygon became "Likely private" and
missing weather became 0°, calm, 0 % rain or a clear sky.

## ADR-003 Daylight is astronomy; legal hours are not modeled — accepted (2026-10-13)

**Decision.** The app shows sunrise/sunset and an optional **personal light
window** (user-set minutes, default 30/30, labeled "not a legal rule"). The
hard-coded `AZ_SHOOT_LEAD_MIN` and the Arizona/Idaho shooting-hours statements
were removed. The weather card links to the responsible agency instead.

**Why.** Spec §7: legal hours depend on jurisdiction, species, season and
method, and no verified rule source exists in the app yet. A verified-rules
registry (with source URL, effective dates, checked date) is future work in
the national catalog (CC-03).

## ADR-004 Delegation model for this implementation — accepted (2026-10-13)

**Decision.** The coordinator implements slices that touch shared files
(`HuntApp.tsx`, `MapCanvas.tsx`, `store.ts`, `types.ts`) sequentially, and uses
subagents for independent work: read-only provider research (Wave 0) and
independent CC-12 reviews of high-risk slices.

**Why.** Early slices all converge on the same shared files; parallel writers
would conflict. The spec itself notes parallel work is not automatically
cheaper or more reliable.

## ADR-005 Phone architecture — open

Phase 0A / REL-02 has not been decided. No physical iOS/Android devices are
available to this agent. The current PWA's `watchPosition` recording is
foreground-only and unverified on locked screens. See
[implementation-status.md](implementation-status.md) CC-01.

## ADR-006 Esri World Imagery caching — open (owner decision)

The provider register ([data-sources.md](data-sources.md) entry 2) records
that Esri's published terms forbid tile harvesting and redistribution outside
Esri software/subscriptions, and that the service reports
`exportTilesAllowed: false`. Fieldline currently caches viewed World Imagery
tiles and pre-fetches them in "Save this view offline". Options: stop caching
and pre-fetching Esri imagery (keep live viewing), replace it with a permitted
imagery source for offline use, or obtain a license. This is an owner and
legal decision; no code was changed for it yet.

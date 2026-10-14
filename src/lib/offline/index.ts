/**
 * Offline map packages (CC-05 wave 2): planning, the package/asset store,
 * resumable download, verification/repair, serving through `fltile://`, and
 * coverage for trip readiness. See docs/storage.md "Offline packages".
 */
export {
  boundsContain,
  boundsContainPoint,
  boundsIntersect,
  planPackage,
  tileRanges,
  type PackageBounds,
  type PackagePlan,
  type PlannedLayer,
  type PlanRequest,
  type PlanViolation,
  type TileCoord,
  type TileRange,
} from "./plan.ts";
export {
  canonicalAssetUrl,
  isRestrictedSource,
  PACKAGE_FONTSTACKS,
  PACKAGE_GLYPH_RANGES,
  PACKAGE_LAYERS,
  PACKAGE_LIMITS,
  packageRuleFor,
  PROVIDER_LIMITS,
  SELECTABLE_LAYERS,
  UNPACKAGEABLE_LAYERS,
  type PackageLayerId,
  type ProviderId,
} from "./sources.ts";
export {
  OfflinePackageStore,
  PACKAGE_SCHEMA_VERSION,
  type AssetFailure,
  type CoverageResult,
  type IntegrityStatus,
  type LayerCoverage,
  type ManifestLayer,
  type ManifestPhase,
  type ManifestSummary,
  type PackageCoverage,
  type PackageManifest,
  type PackageState,
  type PackageStatus,
} from "./package-store.ts";
export {
  downloadPackage,
  parseRetryAfter,
  repairPackage,
  type DownloadOptions,
  type DownloadResult,
} from "./download.ts";
export { verifyPackage, type VerifyResult } from "./verify.ts";
export { createPackageTileSource } from "./serve.ts";

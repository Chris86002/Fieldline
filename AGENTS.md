# Contributor notes

- Use Node.js 22.13+ (22.x) or 24+ and the npm scripts documented in `README.md`.
- Keep the hunting-map identity and saved-data compatibility (`fieldline-v1`).
- Preserve provider attribution, legal-boundary caveats, and offline limitations.
- Keep public-service requests bounded, validated, and respectful of provider
  terms. Do not add credentials, paid services, or a cloud database without a
  clear product need.
- Add focused regression tests for domain or persistence changes, then run
  `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build`.

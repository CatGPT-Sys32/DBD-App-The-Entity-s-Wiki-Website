# DBD Entity Wiki Deployments

Automated scraping, data normalization, and deployment pipeline for The Entity's Wiki, an offline-first Dead by Daylight (DBD) companion application. The project serves both web users and builds a native Android app via Capacitor, with assets optimized and deployed to Cloudflare Pages and Cloudflare R2.

## Project Structure

* `the-entity-wiki/` - Core application codebase.
  * `web/` - Web frontend assets.
  * `android/` - Capacitor Android wrapper project.
  * `scripts/` - Utilities for image normalization, asset uploads, and data contract verification.
* `api/` - Scraping utilities, raw data archives, and content extraction scripts.
* `assets/` - Shared assets and icons.

## Data Pipelines

The project relies on custom scraping and normalization scripts in `the-entity-wiki/scripts/` to keep wiki content up to date:
* `sync:cosmetics` - Discovers, normalizes, and audits in-game cosmetics.
* `sync:perk-descriptions` - Pulls and parses structured perk information.
* `check:data` - Audits image integrity, tests teachables, and verifies data contracts.

## Deployment Architecture

The production environment is hosted on Cloudflare to minimize latency and hosting costs:
1. **Cloudflare Pages** hosts the static web frontend (`the-entity-wiki/web`). Deploys are automated via GitHub Actions on push to `main`.
2. **Cloudflare R2** stores heavy game assets (icons, maps, artwork) to keep the initial page load light and allow progressive asset delivery.

### Manual R2 Asset Sync

Heavy assets are pushed incrementally using the R2 upload utility (requires `rclone` configured):

```bash
./the-entity-wiki/scripts/upload-r2-assets.sh \
  --bucket entity-wiki-assets \
  --public-base-url https://assets.yourdomain.com \
  --source the-entity-wiki/web/dbd_images
```

## Local Development and Android Builds

Ensure dependencies are installed in `the-entity-wiki`:

```bash
cd the-entity-wiki
npm install
```

### Build Android Release

To prepare data and build the release-ready native Android package (`.apk` or `.aab`):

```bash
npm run android:build
```

For Google Play deployments:

```bash
npm run android:bundle:play
```

## Continuous Integration

The deployment workflow is defined in `.github/workflows/deploy-cloudflare.yml`. It triggers on push to the `main` branch and deploys the static package using Wrangler.

Required repository secrets:
* `CLOUDFLARE_ACCOUNT_ID`
* `CLOUDFLARE_API_TOKEN`

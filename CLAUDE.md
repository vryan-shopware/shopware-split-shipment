# CLAUDE.md

Shopware 6.7 plugin `DemoSplitShipment`: ship one order to several addresses. The README explains the behaviour, Store API and admin routes.

## Checks
PHP is not installed on the Mac. PHP runs on the Shopware Build host (SSH alias `SHOPWARE_BUILD_SSH_HOST` in `shopware-demo-creator/.env`).
- PHP syntax: `bin/lint-php.sh <ssh-alias>` (copies tracked `*.php` to a temp dir on the host and runs `php -l`)
- Admin JS: `node --check src/Resources/app/administration/src/main.js`
- Behaviour, against a live demo instance (needs that demo's `*-provisioning.json` from the creator's `artifacts/`):
  - `node tests/demo-setup.mjs --provisioning=<file>` once per instance
  - `node tests/smoke.mjs --provisioning=<file> [--order]`
  - `node tests/order-editor.mjs --provisioning=<file> --order=<orderNumber>`
  These change demo data on that instance (they restore plugin settings and discard drafts). Ask before running them on a prospect's demo.

## Gotchas
- After changing `src/Resources/app/administration/src/main.js`, run `node bin/build-admin.mjs` and commit the generated `src/Resources/public/administration` too. There is no Shopware admin toolchain here.
- The creator's `npm run addon:split-shipment` uploads `git archive HEAD` of the checkout at `../shopware-split-shipment` (or `SITE_FACTORY_SPLIT_SHIPMENT_SOURCE`), whatever branch it is on, and refuses to run while that checkout has uncommitted changes.
- PHP changes on a Build instance show up only after `bin/console cache:clear` and up to 60 seconds of opcache. New routes 404 until then.
- `src/Resources/app/administration/src/main.js` is one file without imports on purpose (see README). Keep it that way.

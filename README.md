# Split shipments for Shopware 6.7 (`DemoSplitShipment`)

Lets a signed-in buyer ship one order to several of their saved addresses. Each address becomes its own delivery, shipping is charged once or per destination, and tax follows each item's destination.

Built as a demo plugin for the Evergreen prospect demo. Tested on Shopware 6.7.15.1.

## What it does

- **Assign units to addresses.** For each cart line, the buyer says how many units go to which saved address. Units not assigned ship to the checkout shipping address.
- **One delivery per destination.** The cart gets one delivery per address. The order gets one order delivery per address, with its own shipping address, positions and shipping costs. This is core order data, so it shows in the admin and reaches an ERP like any other delivery.
- **Tax by destination.** Each line's share for a destination is taxed with that destination's tax rules (country, state, zip code or zip range, the same rule types Shopware uses). A line can carry several tax rates. Shipping tax follows the lines in each delivery.
- **Shipping charge setting** (Settings → Extensions → Split shipments):
  - *Charge separately per destination* (default): each destination is priced as its own shipment with the shipping method's price matrix (by quantity, price, weight or volume).
  - *Charge once per order*: the shipping method is priced on the whole cart and charged on the first delivery; other destinations ship free.
  - *Fee per additional destination*: optional handling fee on every destination after the first.
  - *Maximum destinations per order*, and an on/off switch per sales channel.

## Store API

| Route | What |
| --- | --- |
| `GET /store-api/split-shipment` | Settings and the cart's current assignments. Login required. |
| `POST /store-api/split-shipment/allocations` | Body `{"allocations": {"<lineItemId>": {"<customerAddressId>": 4}}}`. Replaces the assignments (`{}` clears them) and returns the recalculated cart, with one entry per destination in `cart.deliveries`. Only the buyer's own addresses are accepted, and a line can't be over-assigned (HTTP 400). |

Assignments are stored on the cart as `cart.extensions.splitShipment`.

## How it works

Two cart processors:

1. `SplitShipmentLineItemProcessor` (priority 4950, right after products are priced): splits each assigned line into per-destination shares, prices each share with its destination's tax rules (`DestinationTaxResolver`), and sets the line price to the sum of the shares.
2. `SplitShipmentDeliveryProcessor` (priority -5100, right after Shopware builds the default delivery): replaces the single delivery with one delivery per destination and prices shipping according to the setting.

Admin order edits that keep the original shipping costs (`SKIP_DELIVERY_PRICE_RECALCULATION`) are left alone.

## Storefront

The demo's headless storefront (shopware-demo-frontend) shows a "Ship to multiple addresses" step at checkout when this plugin answers `/store-api/split-shipment`, and switches the order summary to the live Shopware totals (shipments, shipping, tax by rate). The Twig storefront has no UI for it yet.

## Install

Copy this folder to `custom/plugins/DemoSplitShipment`, then:

```bash
bin/console plugin:refresh
bin/console plugin:install --activate DemoSplitShipment
bin/console cache:clear
```

## Test against a demo instance

```bash
node tests/demo-setup.mjs --provisioning=<path to *-provisioning.json>
node tests/smoke.mjs --provisioning=<path to *-provisioning.json> [--order]
```

`demo-setup` gives Standard shipping a flat price and adds Virginia and Texas addresses to the demo buyer (demo data). `smoke` puts 10 units in the cart, sends 4 to Virginia and 3 to Texas, and checks deliveries, shipping and tax in both modes, the fee, validation, and (with `--order`) the placed order's deliveries.

US tax rules must exist for tax by state to show anything; the demo factory's `scripts/seed-us-sales-tax.mjs` adds demo statewide rates.

## Not covered

- Per-line requested ship dates (a separate light extension; see the Evergreen answers doc).
- Promotions that discount shipping are applied per delivery by Shopware; not specifically tested.
- Gross-price sales channels: supported, but tested only with net (B2B) prices.

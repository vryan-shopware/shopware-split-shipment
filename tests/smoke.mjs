// Store API smoke test for split shipments against a live demo instance.
//
//   node tests/smoke.mjs --provisioning=<path to *-provisioning.json> [--product=GU3S4LG26] [--order]
//
// Signs in as the demo buyer, puts 10 units of one product in the cart, assigns 4 to
// one extra address and 3 to another, and checks deliveries, shipping and tax in both
// shipping modes and with the per-destination fee. --order also places the order and
// checks its deliveries in the admin API. Restores the plugin settings afterwards.

import { readFileSync } from "node:fs";
import { adminClient, arg, storeClient } from "./lib.mjs";

const provisioning = JSON.parse(readFileSync(arg("provisioning"), "utf8"));
const productNumber = arg("product", "GU3S4LG26");
const placeOrder = process.argv.includes("--order");
const admin = await adminClient(provisioning);
const store = storeClient(provisioning);
const KEY = "DemoSplitShipment.config.";

let failures = 0;
function check(label, actual, expected) {
  const ok = typeof expected === "number" ? Math.abs(actual - expected) < 0.011 : actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}: ${actual}${ok ? "" : ` (expected ${expected})`}`);
}
const money = (value) => Math.round(value * 100) / 100;
const round = (value) => Math.round(value * 100 + Number.EPSILON) / 100;

function summary(cart) {
  return cart.deliveries.map((delivery) => ({
    state: delivery.location.state?.shortCode || delivery.location.address?.countryState?.shortCode || "?",
    city: delivery.location.address?.city,
    units: delivery.positions.reduce((sum, position) => sum + position.quantity, 0),
    goods: money(delivery.positions.reduce((sum, position) => sum + position.price.totalPrice, 0)),
    shipping: delivery.shippingCosts.totalPrice,
    shippingTax: money(delivery.shippingCosts.calculatedTaxes.reduce((sum, tax) => sum + tax.tax, 0))
  }));
}

function taxByRate(cart) {
  return Object.fromEntries(cart.price.calculatedTaxes.map((tax) => [tax.taxRate, tax.tax]));
}

await admin.setConfig({ [`${KEY}enabled`]: true, [`${KEY}shippingCostMode`]: "perDestination", [`${KEY}additionalDestinationFee`]: 0 });

await store.login("admin@shopware.com", "shopware");
await store.delete("checkout/cart").catch(() => {});
const product = (await store.post("product", { filter: [{ type: "equals", field: "productNumber", value: productNumber }], limit: 1 })).elements[0];
const unit = product.calculatedPrice.unitPrice;
let cart = await store.post("checkout/cart/line-item", { items: [{ type: "product", referencedId: product.id, quantity: 10 }] });
const line = cart.lineItems.find((item) => item.referencedId === product.id);
console.log(`${product.translated.name}: 10 × ${unit}`);

const me = await store.get("account/customer");
const addresses = (await store.post("account/list-address", {})).elements;
const va = addresses.find((address) => address.countryState?.shortCode === "US-VA");
const tx = addresses.find((address) => address.countryState?.shortCode === "US-TX");
const primary = addresses.find((address) => address.id === me.defaultShippingAddressId);
console.log(`Primary: ${primary.city} ${primary.countryState?.shortCode}; extra: ${va.city} VA, ${tx.city} TX`);

const loaded = await store.get("split-shipment");
check("route reports enabled", loaded.config.enabled, true);

console.log("\nPer destination, no fee");
cart = await store.post("split-shipment/allocations", { allocations: { [line.id]: { [va.id]: 4, [tx.id]: 3 } } });
const perDestination = summary(cart);
console.table(perDestination);
check("deliveries", cart.deliveries.length, 3);
const ship = 12.95;
const goods = { IL: 3 * unit, VA: 4 * unit, TX: 3 * unit };
check("line total", cart.lineItems.find((item) => item.id === line.id).price.totalPrice, 10 * unit);
const rates = taxByRate(cart);
check("tax at 6.25% (IL + TX goods and shipping)", rates["6.25"], round(goods.IL * 0.0625) + round(goods.TX * 0.0625) + 2 * round(ship * 0.0625));
check("tax at 5.3% (VA goods and shipping)", rates["5.3"], round(goods.VA * 0.053) + round(ship * 0.053));
check("shipping total", money(cart.deliveries.reduce((sum, delivery) => sum + delivery.shippingCosts.totalPrice, 0)), 3 * ship);

console.log("\nCharged once per order");
await admin.setConfig({ [`${KEY}shippingCostMode`]: "single" });
cart = await store.get("checkout/cart");
console.table(summary(cart));
check("deliveries", cart.deliveries.length, 3);
check("shipping total", money(cart.deliveries.reduce((sum, delivery) => sum + delivery.shippingCosts.totalPrice, 0)), ship);

console.log("\nPer destination with a 5.00 fee per extra destination");
await admin.setConfig({ [`${KEY}shippingCostMode`]: "perDestination", [`${KEY}additionalDestinationFee`]: 5 });
cart = await store.get("checkout/cart");
console.table(summary(cart));
check("shipping total", money(cart.deliveries.reduce((sum, delivery) => sum + delivery.shippingCosts.totalPrice, 0)), 3 * ship + 2 * 5);
await admin.setConfig({ [`${KEY}additionalDestinationFee`]: 0 });

console.log("\nValidation");
for (const [label, body] of [
  ["more units than the cart has", { [line.id]: { [va.id]: 8, [tx.id]: 5 } }],
  ["someone else's address", { [line.id]: { "0123456789abcdef0123456789abcdef": 1 } }]
]) {
  const status = await store.post("split-shipment/allocations", { allocations: body }).then(() => 200, (error) => error.status);
  check(`rejects ${label}`, status, 400);
}

if (placeOrder) {
  console.log("\nPlace the order");
  cart = await store.post("split-shipment/allocations", { allocations: { [line.id]: { [va.id]: 4, [tx.id]: 3 } } });
  const order = await store.post("checkout/order", {});
  const full = (await admin.search("order", {
    ids: [order.id],
    associations: { deliveries: { associations: { shippingOrderAddress: { associations: { countryState: {} } }, positions: {} } } }
  })).data[0];
  console.log(`Order ${full.orderNumber}: total ${full.amountTotal}, tax ${full.price.totalPrice - full.price.netPrice}`);
  for (const delivery of full.deliveries) {
    const address = delivery.shippingOrderAddress;
    console.log(`  delivery to ${address.city} ${address.countryState?.shortCode}: ${delivery.positions.reduce((s, p) => s + p.quantity, 0)} units, shipping ${delivery.shippingCosts.totalPrice}`);
  }
  check("order deliveries", full.deliveries.length, 3);
} else {
  await store.post("split-shipment/allocations", { allocations: {} });
  await store.delete("checkout/cart").catch(() => {});
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);

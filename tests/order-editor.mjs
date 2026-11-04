// Exercises the admin shipment editor on a draft version of a split-shipment order,
// checks the repriced order, then throws the draft away (the live order is untouched).
//   node tests/order-editor.mjs --provisioning=<*-provisioning.json> --order=<orderNumber>
import { readFileSync } from "node:fs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const prov = JSON.parse(readFileSync(args.provisioning, "utf8"));
const host = (prov.env?.SHOPWARE_ADMIN_API_URL || prov.env?.SHOPWARE_API_URL || prov.instance.address)
  .replace(/^https?:\/\//, "").replace(/\/api\/?$/, "").replace(/\/$/, "");
const root = `https://${host}`;

const token = (await (await fetch(`${root}/api/oauth/token`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ grant_type: "password", client_id: "administration", scope: "write", username: prov.admin.username, password: prov.admin.password }),
})).json()).access_token;

async function api(method, path, body, versionId) {
  const r = await fetch(`${root}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json", ...(versionId ? { "sw-version-id": versionId } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  const json = text ? JSON.parse(text) : null;
  if (!r.ok) {
    const error = new Error(`${method} ${path} ${r.status}: ${text.slice(0, 400)}`);
    error.status = r.status;
    throw error;
  }
  return json;
}

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures++;
};
const round = (n) => Math.round(n * 100) / 100;

const orders = await api("POST", "/search/order", { filter: [{ type: "equals", field: "orderNumber", value: args.order }], limit: 1 });
const orderId = orders.data[0].id;
const { versionId } = await api("POST", `/_action/version/order/${orderId}`);
console.log(`order ${args.order}, draft version ${versionId}`);

try {
  const before = await api("GET", `/_action/split-shipment/order/${orderId}`, undefined, versionId);
  const line = before.lineItems[0];
  const byCity = Object.fromEntries(before.shipments.map((s) => [s.address.city, s]));
  check("describe lists shipments", before.shipments.length >= 3, before.shipments.map((s) => s.address.city).join(", "));
  const saved = before.customerAddresses.find((a) => a.city === "Chicago") || before.customerAddresses[0];
  const outfit = (await api("POST", "/search/product", {
    limit: 1,
    filter: [{ type: "contains", field: "name", value: "Outfit" }, { type: "equals", field: "active", value: true }, { type: "range", field: "stock", parameters: { gte: 5 } }],
  })).data[0];
  const outfitNet = outfit.price[0].net;

  const plan = {
    lineItems: { [line.id]: { unitPrice: 50 } },
    newLineItems: [{ productId: outfit.id }],
    shipments: [
      { id: byCity.Chicago.id, shippingCost: 12.95, address: {}, quantities: { [line.id]: 2 } },
      { id: byCity.Richmond.id, shippingCost: 12.95, address: { street: "8200 Patterson Avenue" }, quantities: { [line.id]: 5, [outfit.id]: 2 } },
      { id: byCity.Austin.id, shippingCost: 20, address: {}, quantities: { [line.id]: 3 } },
      { shippingCost: 9.5, address: { customerAddressId: saved.id }, quantities: { [line.id]: 1 } },
    ],
  };
  const after = await api("POST", `/_action/split-shipment/order/${orderId}`, plan, versionId);
  check("four shipments", after.shipments.length === 4);
  check("line quantity is the sum", after.lineItems[0].quantity === 11, String(after.lineItems[0].quantity));
  check("unit price changed", after.lineItems[0].unitPrice === 50);
  const added = after.lineItems.find((l) => l.label.includes("Outfit"));
  check("new item added", !!added && added.quantity === 2, added ? `${added.label} ${added.quantity}x${added.unitPrice}` : "missing");
  check("new item priced from catalog", added?.unitPrice === outfitNet, `${added?.unitPrice} vs ${outfitNet}`);
  check("new item ships to Richmond", after.shipments.find((s) => s.address.city === "Richmond").quantities[added?.id] === 2);
  const richmond = after.shipments.find((s) => s.address.city === "Richmond");
  check("address edited", richmond.address.street === "8200 Patterson Avenue");

  const order = (await api("POST", "/search/order", {
    ids: [orderId],
    associations: { deliveries: { associations: { positions: {}, shippingOrderAddress: { associations: { countryState: {} } } } }, lineItems: {}, transactions: {} },
  }, versionId)).data[0];

  // Expected: Chicago IL 3 units (2 + new shipment 1) at 6.25%, VA 5 at 5.3%, TX 3 at 6.25%.
  const shipping = round(12.95 + 12.95 + 20 + 9.5);
  check("shipping total", round(order.shippingTotal) === shipping, `${order.shippingTotal} vs ${shipping}`);
  check("net total", round(order.amountNet) === round(11 * 50 + 2 * outfitNet + shipping), String(order.amountNet));
  const taxes = Object.fromEntries(order.price.calculatedTaxes.map((t) => [t.taxRate, t.tax]));
  const rateOf = (s) => ({ "US-IL": 6.25, "US-VA": 5.3, "US-TX": 6.25 })[s.shippingOrderAddress.countryState?.shortCode];
  const expected = {};
  for (const d of order.deliveries) {
    const goods = d.positions.reduce((n, p) => n + p.price.totalPrice, 0);
    const rate = rateOf(d);
    expected[rate] = (expected[rate] || 0) + goods * rate / 100 + d.shippingCosts.totalPrice * rate / 100;
  }
  for (const [rate, tax] of Object.entries(expected)) {
    check(`tax at ${rate}%`, Math.abs((taxes[rate] ?? 0) - tax) < 0.03, `${taxes[rate]} vs ${round(tax)}`);
  }
  check("total = net + tax", Math.abs(order.amountTotal - order.amountNet - Object.values(taxes).reduce((a, b) => a + b, 0)) < 0.02, String(order.amountTotal));
  check("payment amount follows", Math.abs(order.transactions[0].amount.totalPrice - order.amountTotal) < 0.01, String(order.transactions[0].amount.totalPrice));
  check("positions match lines", order.deliveries.flatMap((d) => d.positions).reduce((n, p) => n + p.quantity, 0) === 13);

  // Validation.
  for (const [label, bad] of [
    ["empty shipment rejected", { shipments: [{ id: byCity.Chicago.id, quantities: {} }] }],
    ["negative cost rejected", { shipments: [{ id: byCity.Chicago.id, shippingCost: -1, quantities: { [line.id]: 1 } }] }],
    ["too many units of a new item rejected", { newLineItems: [{ productId: outfit.id }], shipments: [{ id: byCity.Chicago.id, shippingCost: 1, quantities: { [line.id]: 1, [outfit.id]: 100000 } }] }],
    ["adding an item already on the order rejected", { newLineItems: [{ productId: line.productId || "x" }], shipments: [{ id: byCity.Chicago.id, shippingCost: 1, quantities: { [line.id]: 1 } }] }],
    ["foreign address rejected", { shipments: [{ shippingCost: 1, address: { customerAddressId: "0".repeat(32) }, quantities: { [line.id]: 1 } }] }],
  ]) {
    const status = await api("POST", `/_action/split-shipment/order/${orderId}`, bad, versionId).then(() => 200, (e) => e.status);
    check(label, status === 400, String(status));
  }
} finally {
  await api("POST", `/_action/version/${versionId}/order/${orderId}`).catch((e) => console.log("draft cleanup:", e.message));
}

const live = await api("POST", "/search/order", { ids: [orderId], associations: { deliveries: {} } });
check("live order untouched", live.data[0].deliveries.length === 3 && live.data[0].amountTotal === 623.44, `${live.data[0].deliveries.length} shipments, ${live.data[0].amountTotal}`);
process.exitCode = failures ? 1 : 0;

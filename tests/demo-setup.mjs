// One-time demo setup for testing split shipments on a demo instance (demo data only):
//   - Standard shipping costs a flat amount per shipment (so per-destination charges show)
//   - the demo buyer gets store addresses in other states
//
//   node tests/demo-setup.mjs --provisioning=<path to *-provisioning.json> [--email=admin@shopware.com]
//     [--shipping=12.95] [--company="Acme Buying Team"]

import { readFileSync } from "node:fs";
import { adminClient, arg } from "./lib.mjs";

const provisioning = JSON.parse(readFileSync(arg("provisioning"), "utf8"));
const email = arg("email", "admin@shopware.com");
const shippingPrice = Number(arg("shipping", "12.95"));
const company = arg("company", "Demo Buying Team");
const admin = await adminClient(provisioning);

const ADDRESSES = [
  { key: "va", company: `${company} · Richmond store`, street: "8100 Patterson Avenue", city: "Richmond", zipcode: "23229", state: "US-VA" },
  { key: "tx", company: `${company} · Austin store`, street: "1810 S Lamar Boulevard", city: "Austin", zipcode: "78704", state: "US-TX" }
];

const shipping = (await admin.search("shipping-method", { filter: [{ type: "equals", field: "technicalName", value: "shipping_standard" }], associations: { prices: {} } })).data[0]
  || (await admin.search("shipping-method", { filter: [{ type: "equals", field: "name", value: "Standard" }], associations: { prices: {} } })).data[0];
const usd = (await admin.search("currency", { filter: [{ type: "equals", field: "isoCode", value: "USD" }] })).data[0];
const defaultCurrency = "b7d2554b0ce847cd82f3ac9bd1c0dfca";
for (const price of shipping.prices || shipping.attributes?.prices || []) {
  const currencyPrice = [{ currencyId: defaultCurrency, net: shippingPrice, gross: shippingPrice, linked: false }];
  if (usd && usd.id !== defaultCurrency) currencyPrice.push({ currencyId: usd.id, net: shippingPrice, gross: shippingPrice, linked: false });
  await admin.patch(`shipping-method-price/${price.id}`, { currencyPrice });
}
console.log(`Standard shipping: ${shippingPrice} per shipment`);

const customer = (await admin.search("customer", { filter: [{ type: "equals", field: "email", value: email }], associations: { addresses: {} } })).data[0];
const us = (await admin.search("country", { filter: [{ type: "equals", field: "iso", value: "US" }], associations: { states: {} } })).data[0];
const states = Object.fromEntries((us.states || us.attributes?.states).map((s) => [s.shortCode ?? s.attributes?.shortCode, s.id]));
const existing = (customer.addresses || customer.attributes?.addresses || []).map((a) => a.street ?? a.attributes?.street);
const first = (customer.addresses || customer.attributes?.addresses)[0];
for (const address of ADDRESSES) {
  if (existing.includes(address.street)) continue;
  await admin.post("customer-address", {
    customerId: customer.id,
    salutationId: first.salutationId ?? first.attributes?.salutationId,
    firstName: customer.firstName ?? customer.attributes?.firstName,
    lastName: customer.lastName ?? customer.attributes?.lastName,
    company: address.company,
    street: address.street,
    city: address.city,
    zipcode: address.zipcode,
    countryId: us.id,
    countryStateId: states[address.state]
  });
  console.log(`Address added: ${address.city}, ${address.state}`);
}

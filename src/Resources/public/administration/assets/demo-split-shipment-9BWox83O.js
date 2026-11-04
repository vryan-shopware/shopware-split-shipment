/**
 * Admin order page support for split shipments.
 *
 * Shopware's order page assumes one delivery per order: it shows the primary
 * delivery's address and status, and lists every other delivery in the summary
 * as a shipping discount. For split-shipment orders this adds a "Shipments" card
 * (one row per destination: address, items, shipping, status and tracking) and
 * labels the summary's extra shipping lines as shipments.
 *
 * This file has no imports on purpose: bin/build-admin.mjs publishes it as the
 * plugin's admin bundle without the Shopware admin build toolchain. Text comes
 * from snippet/en.json and snippet/de.json, which Shopware loads by itself.
 */
const { Component, Mixin, Store, Utils } = Shopware;
const { Criteria } = Shopware.Data;

const STYLE_ID = 'demo-split-shipment-style';
const STYLE = `
.demo-split-shipment__intro { margin: 0 0 16px; color: var(--color-text-secondary-default, #52667a); }
.demo-split-shipment__row { display: grid; grid-template-columns: minmax(180px, 1.1fr) minmax(200px, 1.4fr) minmax(140px, .8fr) minmax(220px, 1.2fr); gap: 16px 24px; padding: 16px 0; }
.demo-split-shipment__row + .demo-split-shipment__row { border-top: 1px solid var(--color-border-primary-default, #d1d9e0); }
.demo-split-shipment__label { display: block; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--color-text-secondary-default, #52667a); margin-bottom: 6px; }
.demo-split-shipment__title { font-weight: 600; margin-bottom: 2px; }
.demo-split-shipment__address { line-height: 1.5; }
.demo-split-shipment__items { list-style: none; margin: 0; padding: 0; line-height: 1.6; }
.demo-split-shipment__qty { display: inline-block; min-width: 34px; font-weight: 600; font-variant-numeric: tabular-nums; }
.demo-split-shipment__money { font-weight: 600; font-variant-numeric: tabular-nums; }
.demo-split-shipment__muted { color: var(--color-text-secondary-default, #52667a); font-size: 13px; }
.demo-split-shipment__status { display: flex; flex-direction: column; gap: 8px; }
.demo-split-shipment__status .sw-field, .demo-split-shipment__status .mt-field { margin-bottom: 0; }
.demo-split-shipment__totals { display: flex; justify-content: flex-end; gap: 24px; padding-top: 12px; border-top: 1px solid var(--color-border-primary-default, #d1d9e0); }
@media (max-width: 1100px) { .demo-split-shipment__row { grid-template-columns: 1fr 1fr; } }
@media (max-width: 640px) { .demo-split-shipment__row { grid-template-columns: 1fr; } }
`;

if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLE;
    document.head.appendChild(style);
}

/** Real shipping discounts are negative; split-shipment deliveries never are. */
function isSplitShipmentOrder(order) {
    const deliveries = order?.deliveries ? Array.from(order.deliveries) : [];
    return deliveries.length > 1 && deliveries.every((delivery) => (delivery.shippingCosts?.totalPrice ?? 0) >= 0);
}

Component.register('demo-split-shipment-card', {
    template: `
<mt-card
    v-if="loading || deliveries.length > 1"
    class="demo-split-shipment"
    position-identifier="demo-split-shipment-card"
    :is-loading="loading"
    :title="$tc('demo-split-shipment.card.title', deliveries.length, { count: deliveries.length })"
>
    <p class="demo-split-shipment__intro">
        {{ $t('demo-split-shipment.card.intro') }}
    </p>

    <div
        v-for="(delivery, index) in deliveries"
        :key="delivery.id"
        class="demo-split-shipment__row"
    >
        <div>
            <span class="demo-split-shipment__label">
                {{ $t('demo-split-shipment.card.shipment', { index: index + 1, count: deliveries.length }) }}
            </span>
            <div class="demo-split-shipment__address">
                <div
                    v-for="(line, lineIndex) in addressLines(delivery.shippingOrderAddress)"
                    :key="lineIndex"
                    :class="lineIndex === 0 ? 'demo-split-shipment__title' : ''"
                >
                    {{ line }}
                </div>
            </div>
        </div>

        <div>
            <span class="demo-split-shipment__label">
                {{ $tc('demo-split-shipment.card.items', units(delivery), { count: units(delivery) }) }}
            </span>
            <ul class="demo-split-shipment__items">
                <li
                    v-for="position in positions(delivery)"
                    :key="position.id"
                >
                    <span class="demo-split-shipment__qty">{{ position.quantity }} ×</span>
                    {{ position.orderLineItem ? position.orderLineItem.label : '' }}
                </li>
            </ul>
        </div>

        <div>
            <span class="demo-split-shipment__label">{{ $t('demo-split-shipment.card.shipping') }}</span>
            <div class="demo-split-shipment__money">{{ money(delivery.shippingCosts ? delivery.shippingCosts.totalPrice : 0) }}</div>
            <div class="demo-split-shipment__muted">
                {{ delivery.shippingMethod ? (delivery.shippingMethod.translated?.name || delivery.shippingMethod.name) : '' }}
            </div>
            <div
                v-if="delivery.shippingDateLatest"
                class="demo-split-shipment__muted"
            >
                {{ $t('demo-split-shipment.card.shipBy', { date: date(delivery.shippingDateLatest) }) }}
            </div>
        </div>

        <div class="demo-split-shipment__status">
            <span class="demo-split-shipment__label">{{ $t('demo-split-shipment.card.status') }}</span>
            <sw-single-select
                v-if="canEdit && transitions(delivery).length"
                size="small"
                label-property="name"
                value-property="actionName"
                :value="null"
                :options="transitions(delivery)"
                :placeholder="stateName(delivery)"
                :disabled="busyId === delivery.id"
                @update:value="(actionName) => transition(delivery, actionName)"
            />
            <div v-else>
                <mt-badge>{{ stateName(delivery) }}</mt-badge>
            </div>

            <mt-text-field
                size="small"
                :label="$t('demo-split-shipment.card.tracking')"
                :placeholder="$t('demo-split-shipment.card.trackingPlaceholder')"
                :model-value="trackingDraft(delivery)"
                :disabled="!canEdit || busyId === delivery.id"
                @update:model-value="(value) => setTrackingDraft(delivery, value)"
                @change="saveTracking(delivery)"
            />
        </div>
    </div>

    <div
        v-if="deliveries.length > 1"
        class="demo-split-shipment__totals"
    >
        <span>{{ $t('demo-split-shipment.card.totalShipping') }}</span>
        <span class="demo-split-shipment__money">{{ money(totalShipping) }}</span>
    </div>
</mt-card>
`,

    inject: ['repositoryFactory', 'stateMachineService', 'orderStateMachineService', 'acl'],

    emits: ['shipments-changed'],

    mixins: [Mixin.getByName('notification')],

    props: {
        orderId: {
            type: String,
            required: true,
        },
    },

    data() {
        return {
            loading: true,
            deliveries: [],
            states: {},
            trackingDrafts: {},
            busyId: null,
        };
    },

    computed: {
        repository() {
            return this.repositoryFactory.create('order_delivery');
        },

        currency() {
            return Store.get('swOrderDetail').order?.currency;
        },

        canEdit() {
            return this.acl.can('order.editor');
        },

        totalShipping() {
            return this.deliveries.reduce((sum, delivery) => sum + (delivery.shippingCosts?.totalPrice ?? 0), 0);
        },
    },

    watch: {
        orderId: {
            immediate: true,
            handler() {
                this.load();
            },
        },
    },

    methods: {
        async load() {
            if (!this.orderId) {
                return;
            }

            this.loading = true;
            const criteria = new Criteria(1, 50);
            criteria.addFilter(Criteria.equals('orderId', this.orderId));
            criteria.addAssociation('shippingMethod');
            criteria.addAssociation('stateMachineState');
            criteria.addAssociation('shippingOrderAddress.country');
            criteria.addAssociation('shippingOrderAddress.countryState');
            criteria.addAssociation('positions.orderLineItem');
            criteria.addSorting(Criteria.sort('shippingCosts.unitPrice', 'DESC'));

            try {
                const result = await this.repository.search(criteria, Shopware.Context.api);
                const deliveries = Array.from(result);
                // Primary delivery (the order's shipping address) first, then by city.
                const primaryId = Store.get('swOrderDetail').order?.primaryOrderDeliveryId;
                deliveries.sort((a, b) => {
                    if (a.id === primaryId) return -1;
                    if (b.id === primaryId) return 1;
                    return (a.shippingOrderAddress?.city ?? '').localeCompare(b.shippingOrderAddress?.city ?? '');
                });
                this.deliveries = deliveries;
                this.trackingDrafts = Object.fromEntries(
                    deliveries.map((delivery) => [delivery.id, (delivery.trackingCodes ?? []).join(', ')]),
                );
                await this.loadStates();
            } catch (error) {
                this.deliveries = [];
            } finally {
                this.loading = false;
            }
        },

        async loadStates() {
            const entries = await Promise.all(
                this.deliveries.map(async (delivery) => {
                    try {
                        const { data } = await this.stateMachineService.getState('order_delivery', delivery.id);
                        return [delivery.id, data];
                    } catch (error) {
                        return [delivery.id, null];
                    }
                }),
            );
            this.states = Object.fromEntries(entries);
        },

        addressLines(address) {
            if (!address) {
                return ['-'];
            }
            const state = address.countryState?.shortCode?.replace(/^[A-Z]{2}-/, '');
            const cityLine = [address.city, [state, address.zipcode].filter(Boolean).join(' ')]
                .filter(Boolean)
                .join(', ');
            return [
                address.company || [address.firstName, address.lastName].filter(Boolean).join(' '),
                address.company ? [address.firstName, address.lastName].filter(Boolean).join(' ') : null,
                address.street,
                address.additionalAddressLine1,
                cityLine,
                address.country?.translated?.name || address.country?.name,
            ].filter(Boolean);
        },

        positions(delivery) {
            return delivery.positions ? Array.from(delivery.positions) : [];
        },

        units(delivery) {
            return this.positions(delivery).reduce((sum, position) => sum + (position.quantity ?? 0), 0);
        },

        money(value) {
            const decimals = Store.get('swOrderDetail').order?.totalRounding?.decimals ?? 2;
            return Utils.format.currency(value ?? 0, this.currency?.isoCode, decimals);
        },

        date(value) {
            return Utils.format.date(value, { hour: undefined, minute: undefined });
        },

        stateName(delivery) {
            return (
                this.states[delivery.id]?.currentState?.translated?.name ||
                this.states[delivery.id]?.currentState?.name ||
                delivery.stateMachineState?.translated?.name ||
                delivery.stateMachineState?.name ||
                '-'
            );
        },

        transitions(delivery) {
            return (this.states[delivery.id]?.transitions ?? []).map((transition) => ({
                actionName: transition.actionName,
                name: transition.toStateMachineState?.translated?.name || transition.name || transition.actionName,
            }));
        },

        async transition(delivery, actionName) {
            if (!actionName) {
                return;
            }
            this.busyId = delivery.id;
            try {
                await this.orderStateMachineService.transitionOrderDeliveryState(delivery.id, actionName, {
                    sendMail: false,
                });
                this.createNotificationSuccess({
                    message: this.$t('demo-split-shipment.card.statusSaved', {
                        place: this.addressLines(delivery.shippingOrderAddress)[0],
                    }),
                });
                await this.load();
                this.$emit('shipments-changed');
            } catch (error) {
                this.createNotificationError({ message: this.$t('demo-split-shipment.card.statusFailed') });
            } finally {
                this.busyId = null;
            }
        },

        trackingDraft(delivery) {
            return this.trackingDrafts[delivery.id] ?? '';
        },

        setTrackingDraft(delivery, value) {
            this.trackingDrafts = { ...this.trackingDrafts, [delivery.id]: value ?? '' };
        },

        async saveTracking(delivery) {
            const codes = (this.trackingDrafts[delivery.id] ?? '')
                .split(/[,\s]+/)
                .map((code) => code.trim())
                .filter(Boolean);
            const current = delivery.trackingCodes ?? [];
            if (codes.join(',') === current.join(',')) {
                return;
            }
            this.busyId = delivery.id;
            try {
                delivery.trackingCodes = codes;
                await this.repository.save(delivery, Shopware.Context.api);
                this.createNotificationSuccess({ message: this.$t('demo-split-shipment.card.trackingSaved') });
                await this.load();
            } catch (error) {
                this.createNotificationError({ message: this.$t('demo-split-shipment.card.trackingFailed') });
            } finally {
                this.busyId = null;
            }
        },
    },
});

Component.override('sw-order-detail-general', {
    template: `
{% block sw_order_detail_general_line_items_card %}
    {% parent %}
    <demo-split-shipment-card
        v-if="order && order.id"
        :order-id="order.id"
        @shipments-changed="reloadEntityData"
    />
{% endblock %}

{% block sw_order_detail_general_line_items_summary_shipping_cost %}
    <template v-if="demoSplitShipment">
        <dt>{{ $tc('demo-split-shipment.summary.shipping', order.deliveries.length, { count: order.deliveries.length }) }}</dt>
        <dd>{{ currencyFilter(order.shippingTotal, currency.isoCode, order.totalRounding.decimals) }}</dd>
    </template>
    <template v-else>
        {% parent %}
    </template>
{% endblock %}
`,

    computed: {
        demoSplitShipment() {
            return isSplitShipmentOrder(this.order);
        },
    },
});

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
.demo-split-shipment__head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
.demo-split-shipment__intro { margin: 0; color: var(--color-text-secondary-default, #52667a); }
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
.demo-split-shipment-editor__section + .demo-split-shipment-editor__section { margin-top: 24px; }
.demo-split-shipment-editor__heading { font-size: 14px; font-weight: 600; margin: 0 0 12px; }
.demo-split-shipment-editor__table { width: 100%; border-collapse: collapse; }
.demo-split-shipment-editor__table th { text-align: left; font-size: 12px; font-weight: 600; color: var(--color-text-secondary-default, #52667a); padding: 6px 8px; border-bottom: 1px solid var(--color-border-primary-default, #d1d9e0); }
.demo-split-shipment-editor__table td { padding: 8px; vertical-align: middle; border-bottom: 1px solid var(--color-border-primary-default, #d1d9e0); }
.demo-split-shipment-editor__table .mt-field, .demo-split-shipment-editor__table .sw-field { margin-bottom: 0; }
.demo-split-shipment-editor__num { width: 140px; }
.demo-split-shipment-editor__add { display: grid; grid-template-columns: minmax(260px, 420px) 1fr; gap: 4px 16px; align-items: end; margin-top: 12px; }
.demo-split-shipment-editor__add .sw-field { margin-bottom: 0; }
.demo-split-shipment-editor__units { font-variant-numeric: tabular-nums; font-weight: 600; }
.demo-split-shipment-editor__units.is-error { color: var(--color-text-critical-default, #de294c); }
.demo-split-shipment-editor__shipment { border: 1px solid var(--color-border-primary-default, #d1d9e0); border-radius: 8px; padding: 16px; }
.demo-split-shipment-editor__shipment + .demo-split-shipment-editor__shipment { margin-top: 12px; }
.demo-split-shipment-editor__shipment-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 12px; }
.demo-split-shipment-editor__shipment-body { display: grid; grid-template-columns: minmax(220px, 1.2fr) minmax(220px, 1fr) 160px; gap: 16px 24px; }
.demo-split-shipment-editor__address-form { display: grid; grid-template-columns: 1fr 1fr; gap: 0 12px; margin-top: 8px; }
.demo-split-shipment-editor__address-form .is-wide { grid-column: 1 / -1; }
.demo-split-shipment-editor__saved { margin-top: 12px; }
.demo-split-shipment-editor__links { display: flex; gap: 12px; margin-top: 6px; }
.demo-split-shipment-editor__link { background: none; border: 0; padding: 0; color: var(--color-text-brand-default, #0870ff); cursor: pointer; font: inherit; text-decoration: underline; }
.demo-split-shipment-editor__qty { display: grid; grid-template-columns: 1fr 110px; gap: 6px 12px; align-items: center; }
.demo-split-shipment-editor__summary { display: flex; justify-content: flex-end; gap: 24px; margin-top: 16px; font-variant-numeric: tabular-nums; }
@media (max-width: 1100px) { .demo-split-shipment-editor__shipment-body { grid-template-columns: 1fr; } }
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
    v-if="loading || deliveries.length"
    class="demo-split-shipment"
    position-identifier="demo-split-shipment-card"
    :is-loading="loading"
    :title="$tc('demo-split-shipment.card.title', deliveries.length, { count: deliveries.length })"
>
    <div class="demo-split-shipment__head">
        <p class="demo-split-shipment__intro">
            {{ deliveries.length > 1 ? $t('demo-split-shipment.card.intro') : $t('demo-split-shipment.card.introSingle') }}
        </p>
        <mt-button
            v-if="canEdit"
            size="small"
            variant="secondary"
            @click="showEditor = true"
        >
            {{ $t('demo-split-shipment.card.edit') }}
        </mt-button>
    </div>

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

    <demo-split-shipment-editor
        v-if="showEditor"
        :order-id="orderId"
        :version-id="versionContext.versionId"
        @close="showEditor = false"
        @saved="onEditorSaved"
    />
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
            showEditor: false,
        };
    },

    computed: {
        repository() {
            return this.repositoryFactory.create('order_delivery');
        },

        currency() {
            return Store.get('swOrderDetail').order?.currency;
        },

        // The order page edits a draft version; show and save shipment data there.
        versionContext() {
            return Store.get('swOrderDetail').versionContext || Shopware.Context.api;
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
                const result = await this.repository.search(criteria, this.versionContext);
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

        onEditorSaved() {
            this.showEditor = false;
            this.$emit('shipments-changed');
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
                await this.repository.save(delivery, this.versionContext);
                this.createNotificationSuccess({ message: this.$t('demo-split-shipment.card.trackingSaved') });
                this.$emit('shipments-changed');
                await this.load();
            } catch (error) {
                this.createNotificationError({ message: this.$t('demo-split-shipment.card.trackingFailed') });
            } finally {
                this.busyId = null;
            }
        },
    },
});

/**
 * Shipment editor: unit prices, units per shipment, each shipment's address and
 * shipping charge, adding and removing shipments. Saves through the plugin's Admin
 * API into the order page's draft version; Save/Cancel on the page keep or drop it.
 */
Component.register('demo-split-shipment-editor', {
    template: `
<sw-modal
    class="demo-split-shipment-editor"
    variant="large"
    :title="$t('demo-split-shipment.editor.title')"
    :is-loading="loading"
    @modal-close="$emit('close')"
>
    <template v-if="model">
        <mt-banner
            v-if="error"
            variant="critical"
            class="demo-split-shipment-editor__section"
        >
            {{ error }}
        </mt-banner>

        <section class="demo-split-shipment-editor__section">
            <h3 class="demo-split-shipment-editor__heading">{{ $t('demo-split-shipment.editor.items') }}</h3>
            <table class="demo-split-shipment-editor__table">
                <thead>
                    <tr>
                        <th>{{ $t('demo-split-shipment.editor.item') }}</th>
                        <th>{{ model.taxStatus === 'gross' ? $t('demo-split-shipment.editor.unitPriceGross') : $t('demo-split-shipment.editor.unitPriceNet') }}</th>
                        <th>{{ $t('demo-split-shipment.editor.units') }}</th>
                        <th>{{ $t('demo-split-shipment.editor.lineTotal') }}</th>
                    </tr>
                </thead>
                <tbody>
                    <tr
                        v-for="line in model.lineItems"
                        :key="line.id"
                    >
                        <td>
                            <div>
                                {{ line.label }}
                                <mt-badge v-if="line.isNew" variant="info">{{ $t('demo-split-shipment.editor.new') }}</mt-badge>
                            </div>
                            <div class="demo-split-shipment__muted">
                                {{ line.productNumber }}
                                <template v-if="line.isNew">
                                    ·
                                    <button
                                        type="button"
                                        class="demo-split-shipment-editor__link"
                                        @click="removeNewLine(line)"
                                    >{{ $t('demo-split-shipment.editor.remove') }}</button>
                                </template>
                            </div>
                        </td>
                        <td class="demo-split-shipment-editor__num">
                            <mt-number-field
                                size="small"
                                number-type="float"
                                :digits="2"
                                :min="0"
                                :model-value="line.unitPrice"
                                @update:model-value="(value) => { line.unitPrice = value ?? 0; line.priceTouched = true; }"
                            />
                        </td>
                        <td>
                            <span
                                class="demo-split-shipment-editor__units"
                                :class="{ 'is-error': lineUnits(line) === 0 }"
                            >{{ lineUnits(line) }}</span>
                            <span
                                v-if="lineUnits(line) === 0"
                                class="demo-split-shipment__muted"
                            > · {{ line.isNew ? $t('demo-split-shipment.editor.assignUnits') : $t('demo-split-shipment.editor.willBeRemoved') }}</span>
                        </td>
                        <td class="demo-split-shipment__money">{{ money(lineUnits(line) * line.unitPrice) }}</td>
                    </tr>
                </tbody>
            </table>
            <div class="demo-split-shipment-editor__add">
                <sw-entity-single-select
                    entity="product"
                    size="small"
                    :label="$t('demo-split-shipment.editor.addItem')"
                    :placeholder="$t('demo-split-shipment.editor.addItemPlaceholder')"
                    :criteria="productCriteria"
                    :value="null"
                    @update:value="(id, item) => addProduct(id, item)"
                />
                <span class="demo-split-shipment__muted">{{ $t('demo-split-shipment.editor.addItemHint') }}</span>
            </div>
        </section>

        <section class="demo-split-shipment-editor__section">
            <h3 class="demo-split-shipment-editor__heading">{{ $t('demo-split-shipment.editor.shipments') }}</h3>

            <div
                v-for="(shipment, index) in model.shipments"
                :key="shipment.key"
                class="demo-split-shipment-editor__shipment"
            >
                <div class="demo-split-shipment-editor__shipment-head">
                    <strong>
                        {{ $t('demo-split-shipment.card.shipment', { index: index + 1, count: model.shipments.length }) }}
                        · {{ place(shipmentAddress(shipment)) }}
                        <span
                            v-if="!shipment.id"
                            class="demo-split-shipment__muted"
                        > ({{ $t('demo-split-shipment.editor.new') }})</span>
                    </strong>
                    <mt-button
                        v-if="model.shipments.length > 1"
                        size="small"
                        variant="critical"
                        ghost
                        @click="removeShipment(index)"
                    >
                        {{ $t('demo-split-shipment.editor.remove') }}
                    </mt-button>
                </div>

                <div class="demo-split-shipment-editor__shipment-body">
                    <div>
                        <span class="demo-split-shipment__label">{{ $t('demo-split-shipment.editor.shipTo') }}</span>
                        <div class="demo-split-shipment__address">
                            <div
                                v-for="(addressLine, lineIndex) in addressLines(shipmentAddress(shipment))"
                                :key="lineIndex"
                                :class="lineIndex === 0 ? 'demo-split-shipment__title' : ''"
                            >
                                {{ addressLine }}
                            </div>
                        </div>

                        <sw-single-select
                            v-if="model.customerAddresses.length"
                            class="demo-split-shipment-editor__saved"
                            size="small"
                            :label="$t('demo-split-shipment.editor.savedAddress')"
                            :placeholder="$t('demo-split-shipment.editor.savedAddressPlaceholder')"
                            :options="savedAddressOptions"
                            label-property="label"
                            value-property="id"
                            :value="shipment.customerAddressId"
                            @update:value="(id) => useSavedAddress(shipment, id)"
                        />

                        <div class="demo-split-shipment-editor__links">
                            <button
                                type="button"
                                class="demo-split-shipment-editor__link"
                                @click="toggleAddressForm(shipment)"
                            >
                                {{ shipment.editing ? $t('demo-split-shipment.editor.doneEditing') : $t('demo-split-shipment.editor.editAddress') }}
                            </button>
                        </div>

                        <div
                            v-if="shipment.editing"
                            class="demo-split-shipment-editor__address-form"
                        >
                            <mt-text-field
                                class="is-wide"
                                size="small"
                                :label="$t('demo-split-shipment.editor.company')"
                                :model-value="shipment.address.company"
                                @update:model-value="(value) => setAddressField(shipment, 'company', value)"
                            />
                            <mt-text-field
                                size="small"
                                :label="$t('demo-split-shipment.editor.firstName')"
                                :model-value="shipment.address.firstName"
                                @update:model-value="(value) => setAddressField(shipment, 'firstName', value)"
                            />
                            <mt-text-field
                                size="small"
                                :label="$t('demo-split-shipment.editor.lastName')"
                                :model-value="shipment.address.lastName"
                                @update:model-value="(value) => setAddressField(shipment, 'lastName', value)"
                            />
                            <mt-text-field
                                class="is-wide"
                                size="small"
                                :label="$t('demo-split-shipment.editor.street')"
                                :model-value="shipment.address.street"
                                @update:model-value="(value) => setAddressField(shipment, 'street', value)"
                            />
                            <mt-text-field
                                size="small"
                                :label="$t('demo-split-shipment.editor.city')"
                                :model-value="shipment.address.city"
                                @update:model-value="(value) => setAddressField(shipment, 'city', value)"
                            />
                            <mt-text-field
                                size="small"
                                :label="$t('demo-split-shipment.editor.zipcode')"
                                :model-value="shipment.address.zipcode"
                                @update:model-value="(value) => setAddressField(shipment, 'zipcode', value)"
                            />
                            <sw-single-select
                                class="is-wide"
                                size="small"
                                :label="$t('demo-split-shipment.editor.state')"
                                :options="statesFor(shipment.address.countryId)"
                                label-property="name"
                                value-property="id"
                                :value="shipment.address.countryStateId"
                                @update:value="(id) => setAddressField(shipment, 'countryStateId', id)"
                            />
                        </div>
                    </div>

                    <div>
                        <span class="demo-split-shipment__label">{{ $t('demo-split-shipment.editor.unitsToShip') }}</span>
                        <div class="demo-split-shipment-editor__qty">
                            <template
                                v-for="line in model.lineItems"
                                :key="line.id"
                            >
                                <span>{{ line.label }}</span>
                                <mt-number-field
                                    size="small"
                                    number-type="int"
                                    :min="0"
                                    :model-value="shipment.quantities[line.id] || 0"
                                    @update:model-value="(value) => { shipment.quantities[line.id] = value || 0; }"
                                />
                            </template>
                        </div>
                    </div>

                    <div>
                        <span class="demo-split-shipment__label">{{ $t('demo-split-shipment.card.shipping') }}</span>
                        <mt-number-field
                            size="small"
                            number-type="float"
                            :digits="2"
                            :min="0"
                            :model-value="shipment.shippingCost"
                            @update:model-value="(value) => { shipment.shippingCost = value ?? 0; }"
                        />
                        <div class="demo-split-shipment__muted">{{ shipment.shippingMethod }}</div>
                    </div>
                </div>
            </div>

            <div class="demo-split-shipment-editor__links">
                <mt-button
                    size="small"
                    variant="secondary"
                    @click="addShipment"
                >
                    {{ $t('demo-split-shipment.editor.addShipment') }}
                </mt-button>
            </div>

            <div class="demo-split-shipment-editor__summary">
                <span>{{ $t('demo-split-shipment.editor.subtotal') }} <strong>{{ money(subtotal) }}</strong></span>
                <span>{{ $t('demo-split-shipment.card.totalShipping') }} <strong>{{ money(shippingTotal) }}</strong></span>
                <span class="demo-split-shipment__muted">{{ $t('demo-split-shipment.editor.taxNote') }}</span>
            </div>
        </section>
    </template>

    <template #modal-footer>
        <mt-button
            size="small"
            variant="secondary"
            @click="$emit('close')"
        >
            {{ $t('global.default.cancel') }}
        </mt-button>
        <mt-button
            size="small"
            variant="primary"
            :is-loading="saving"
            :disabled="!model"
            @click="save"
        >
            {{ $t('demo-split-shipment.editor.apply') }}
        </mt-button>
    </template>
</sw-modal>
`,

    inject: ['repositoryFactory', 'loginService'],

    emits: ['close', 'saved'],

    mixins: [Mixin.getByName('notification')],

    props: {
        orderId: { type: String, required: true },
        versionId: { type: String, required: false, default: null },
    },

    data() {
        return {
            loading: true,
            saving: false,
            error: '',
            model: null,
            states: [],
            keySeed: 0,
        };
    },

    computed: {
        savedAddressOptions() {
            return (this.model?.customerAddresses ?? []).map((address) => ({
                id: address.id,
                label: [address.company, this.place(address), address.street].filter(Boolean).join(' · '),
            }));
        },

        subtotal() {
            return (this.model?.lineItems ?? []).reduce((sum, line) => sum + this.lineUnits(line) * (line.unitPrice || 0), 0);
        },

        shippingTotal() {
            return (this.model?.shipments ?? []).reduce((sum, shipment) => sum + (shipment.shippingCost || 0), 0);
        },

        productCriteria() {
            const criteria = new Criteria(1, 25);
            criteria.addFilter(Criteria.equals('active', true));
            const inOrder = (this.model?.lineItems ?? []).map((line) => line.productId || line.id).filter(Boolean);
            if (inOrder.length) {
                criteria.addFilter(Criteria.not('AND', [Criteria.equalsAny('id', inOrder)]));
            }
            return criteria;
        },
    },

    created() {
        this.load();
    },

    methods: {
        client() {
            return Shopware.Application.getContainer('init').httpClient;
        },

        headers() {
            return {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.loginService.getToken()}`,
                ...(this.versionId ? { 'sw-version-id': this.versionId } : {}),
            };
        },

        async load() {
            this.loading = true;
            try {
                const { data } = await this.client().get(`/_action/split-shipment/order/${this.orderId}`, {
                    headers: this.headers(),
                });
                this.model = {
                    ...data,
                    shipments: data.shipments.map((shipment) => this.toEditable(shipment)),
                };
                await this.loadStates();
            } catch (error) {
                this.error = this.apiError(error);
            } finally {
                this.loading = false;
            }
        },

        async loadStates() {
            const countryIds = new Set([
                ...this.model.shipments.map((shipment) => shipment.address.countryId),
                ...this.model.customerAddresses.map((address) => address.countryId),
            ].filter(Boolean));
            if (!countryIds.size) {
                return;
            }
            const criteria = new Criteria(1, 500);
            criteria.addFilter(Criteria.equalsAny('countryId', [...countryIds]));
            criteria.addSorting(Criteria.sort('name', 'ASC'));
            const result = await this.repositoryFactory.create('country_state').search(criteria, Shopware.Context.api);
            this.states = Array.from(result).map((state) => ({
                id: state.id,
                countryId: state.countryId,
                shortCode: state.shortCode,
                name: state.translated?.name || state.name,
            }));
        },

        toEditable(shipment) {
            this.keySeed += 1;
            return {
                key: `s${this.keySeed}`,
                id: shipment.id ?? null,
                shippingCost: shipment.shippingCost ?? 0,
                shippingMethod: shipment.shippingMethod ?? '',
                quantities: { ...(shipment.quantities ?? {}) },
                address: { ...(shipment.address ?? {}) },
                original: { ...(shipment.address ?? {}) },
                customerAddressId: null,
                editing: false,
            };
        },

        lineUnits(line) {
            return (this.model?.shipments ?? []).reduce((sum, shipment) => sum + (Number(shipment.quantities[line.id]) || 0), 0);
        },

        shipmentAddress(shipment) {
            return shipment.address;
        },

        place(address) {
            if (!address) {
                return '';
            }
            const state = address.countryStateCode?.replace(/^[A-Z]{2}-/, '')
                || this.states.find((item) => item.id === address.countryStateId)?.shortCode?.replace(/^[A-Z]{2}-/, '');
            return [address.city, state].filter(Boolean).join(', ');
        },

        addressLines(address) {
            if (!address) {
                return ['-'];
            }
            const name = [address.firstName, address.lastName].filter(Boolean).join(' ');
            const state = this.states.find((item) => item.id === address.countryStateId)?.shortCode?.replace(/^[A-Z]{2}-/, '')
                || address.countryStateCode?.replace(/^[A-Z]{2}-/, '');
            return [
                address.company || name,
                address.company ? name : null,
                address.street,
                [address.city, [state, address.zipcode].filter(Boolean).join(' ')].filter(Boolean).join(', '),
            ].filter(Boolean);
        },

        statesFor(countryId) {
            return this.states.filter((state) => state.countryId === countryId);
        },

        useSavedAddress(shipment, id) {
            const saved = this.model.customerAddresses.find((address) => address.id === id);
            if (!saved) {
                return;
            }
            shipment.customerAddressId = id;
            shipment.address = { ...saved };
            shipment.editing = false;
        },

        toggleAddressForm(shipment) {
            shipment.editing = !shipment.editing;
        },

        setAddressField(shipment, field, value) {
            // Editing a picked saved address turns it into a one-off address for this order.
            if (shipment.customerAddressId) {
                shipment.customerAddressId = null;
                shipment.original = {};
            }
            shipment.address = { ...shipment.address, [field]: value, countryStateCode: field === 'countryStateId' ? null : shipment.address.countryStateCode };
        },

        addShipment() {
            const used = new Set(this.model.shipments.map((shipment) => shipment.address?.id));
            const saved = this.model.customerAddresses.find((address) => !used.has(address.id))
                || this.model.customerAddresses[0];
            const primary = this.model.shipments[0];
            const shipment = this.toEditable({
                shippingCost: primary?.shippingCost ?? 0,
                shippingMethod: primary?.shippingMethod ?? '',
                quantities: {},
                address: saved ? { ...saved } : { ...(primary?.address ?? {}) },
            });
            shipment.original = {};
            if (saved) {
                shipment.customerAddressId = saved.id;
            } else {
                shipment.editing = true;
            }
            this.model.shipments.push(shipment);
        },

        removeShipment(index) {
            this.model.shipments.splice(index, 1);
        },

        addProduct(id, item) {
            if (!id || this.model.lineItems.some((line) => (line.productId || line.id) === id)) {
                return;
            }
            const net = item?.price?.[0]?.net;
            const gross = item?.price?.[0]?.gross;
            this.model.lineItems.push({
                id,
                productId: id,
                isNew: true,
                priceTouched: false,
                label: item?.translated?.name || item?.name || item?.productNumber || id,
                productNumber: item?.productNumber || '',
                unitPrice: (this.model.taxStatus === 'gross' ? gross : net) ?? 0,
            });
        },

        removeNewLine(line) {
            this.model.lineItems = this.model.lineItems.filter((item) => item !== line);
            this.model.shipments.forEach((shipment) => {
                delete shipment.quantities[line.id];
            });
        },

        addressPayload(shipment) {
            if (shipment.customerAddressId) {
                return { customerAddressId: shipment.customerAddressId };
            }
            const fields = ['company', 'firstName', 'lastName', 'street', 'zipcode', 'city', 'countryId', 'countryStateId'];
            const changes = {};
            fields.forEach((field) => {
                if ((shipment.address[field] ?? null) !== (shipment.original[field] ?? null)) {
                    changes[field] = shipment.address[field] ?? null;
                }
            });
            if (!shipment.id) {
                fields.forEach((field) => {
                    changes[field] = shipment.address[field] ?? null;
                });
            }
            return changes;
        },

        async save() {
            this.error = '';
            this.saving = true;
            const plan = {
                lineItems: Object.fromEntries(
                    this.model.lineItems
                        .filter((line) => !line.isNew)
                        .map((line) => [line.id, { unitPrice: Number(line.unitPrice) || 0 }]),
                ),
                newLineItems: this.model.lineItems
                    .filter((line) => line.isNew)
                    .map((line) => ({
                        productId: line.id,
                        ...(line.priceTouched ? { unitPrice: Number(line.unitPrice) || 0 } : {}),
                    })),
                shipments: this.model.shipments.map((shipment) => ({
                    ...(shipment.id ? { id: shipment.id } : {}),
                    shippingCost: Number(shipment.shippingCost) || 0,
                    address: this.addressPayload(shipment),
                    quantities: Object.fromEntries(
                        Object.entries(shipment.quantities)
                            .map(([lineId, quantity]) => [lineId, Number(quantity) || 0])
                            .filter(([, quantity]) => quantity > 0),
                    ),
                })),
            };

            try {
                await this.client().post(`/_action/split-shipment/order/${this.orderId}`, plan, {
                    headers: this.headers(),
                });
                this.createNotificationSuccess({ message: this.$t('demo-split-shipment.editor.saved') });
                this.$emit('saved');
            } catch (error) {
                this.error = this.apiError(error);
            } finally {
                this.saving = false;
            }
        },

        apiError(error) {
            return error?.response?.data?.errors?.[0]?.detail || error?.message || this.$t('demo-split-shipment.editor.failed');
        },

        money(value) {
            const order = Store.get('swOrderDetail').order;
            return Utils.format.currency(value ?? 0, order?.currency?.isoCode || this.model?.currency, order?.totalRounding?.decimals ?? 2);
        },
    },
});

Component.override('sw-order-detail-general', {
    template: `
{% block sw_order_detail_general_line_items_card %}
    {% parent %}
    <demo-split-shipment-card
        v-if="order && order.id"
        ref="demoSplitShipmentCard"
        :order-id="order.id"
        @shipments-changed="onDemoShipmentsChanged"
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

    methods: {
        async onDemoShipmentsChanged() {
            await this.reloadEntityData();
            await this.$refs.demoSplitShipmentCard?.load();
        },
    },
});

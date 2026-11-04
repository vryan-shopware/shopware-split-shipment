<?php declare(strict_types=1);

namespace DemoSplitShipment\Checkout\SplitShipment\Order;

use DemoSplitShipment\Checkout\SplitShipment\DestinationTaxResolver;
use DemoSplitShipment\Checkout\SplitShipment\SplitPriceMerger;
use Shopware\Core\Checkout\Cart\Cart;
use Shopware\Core\Checkout\Cart\CartBehavior;
use Shopware\Core\Checkout\Cart\Delivery\Struct\ShippingLocation;
use Shopware\Core\Checkout\Cart\LineItem\LineItem;
use Shopware\Core\Checkout\Cart\LineItemFactoryRegistry;
use Shopware\Core\Checkout\Cart\Order\Transformer\LineItemTransformer;
use Shopware\Core\Checkout\Cart\Processor;
use Shopware\Core\Checkout\Cart\Order\OrderConverter;
use Shopware\Core\Checkout\Cart\Price\AmountCalculator;
use Shopware\Core\Checkout\Cart\Price\QuantityPriceCalculator;
use Shopware\Core\Checkout\Cart\Price\Struct\CalculatedPrice;
use Shopware\Core\Checkout\Cart\Price\Struct\PriceCollection;
use Shopware\Core\Checkout\Cart\Price\Struct\QuantityPriceDefinition;
use Shopware\Core\Checkout\Cart\Tax\PercentageTaxRuleBuilder;
use Shopware\Core\Checkout\Cart\Tax\Struct\TaxRuleCollection;
use Shopware\Core\Checkout\Customer\Aggregate\CustomerAddress\CustomerAddressCollection;
use Shopware\Core\Checkout\Customer\Aggregate\CustomerAddress\CustomerAddressEntity;
use Shopware\Core\Checkout\Order\Aggregate\OrderAddress\OrderAddressEntity;
use Shopware\Core\Checkout\Order\Aggregate\OrderDelivery\OrderDeliveryEntity;
use Shopware\Core\Checkout\Order\Aggregate\OrderDelivery\OrderDeliveryStates;
use Shopware\Core\Checkout\Order\Aggregate\OrderLineItem\OrderLineItemEntity;
use Shopware\Core\Checkout\Order\OrderCollection;
use Shopware\Core\Checkout\Order\OrderEntity;
use Shopware\Core\Framework\Context;
use Shopware\Core\Framework\DataAbstractionLayer\EntityRepository;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Criteria;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Filter\EqualsAnyFilter;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Filter\EqualsFilter;
use Shopware\Core\Framework\Uuid\Uuid;
use Shopware\Core\System\Country\Aggregate\CountryState\CountryStateCollection;
use Shopware\Core\System\Country\CountryCollection;
use Shopware\Core\System\Country\CountryEntity;
use Shopware\Core\System\SalesChannel\SalesChannelContext;
use Shopware\Core\System\StateMachine\Loader\InitialStateIdLoader;
use Shopware\Core\System\Tax\TaxCollection;
use Symfony\Component\HttpKernel\Exception\BadRequestHttpException;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * Edits an order's shipments: which units of which line go to which address, the
 * addresses themselves, each shipment's shipping charge and each line's unit price.
 *
 * Shopware's own order recalculation rebuilds deliveries from the stored positions
 * and prices every line with a single tax rule, which loses split shipments. This
 * reprices the order the same way checkout does with the plugin: each line's share
 * per destination is taxed for that destination, each shipment's shipping is taxed
 * in proportion to its items, and the order totals, the line items, the deliveries
 * and the primary payment amount are written together. It works on whatever order
 * version the context carries, so the admin can edit its draft and Save or Cancel.
 *
 * Lines that aren't shipped (promotions, credits) are kept as they are and counted
 * in the totals.
 */
class SplitShipmentOrderEditor
{
    private const ADDRESS_FIELDS = [
        'salutationId', 'title', 'firstName', 'lastName', 'company', 'department', 'street',
        'additionalAddressLine1', 'additionalAddressLine2', 'zipcode', 'city',
        'countryId', 'countryStateId', 'phoneNumber', 'vatId',
    ];

    private const EDITABLE_ADDRESS_FIELDS = [
        'firstName', 'lastName', 'company', 'department', 'street', 'additionalAddressLine1',
        'additionalAddressLine2', 'zipcode', 'city', 'countryId', 'countryStateId', 'phoneNumber',
    ];

    /**
     * @param EntityRepository<OrderCollection> $orderRepository
     * @param EntityRepository<CustomerAddressCollection> $customerAddressRepository
     * @param EntityRepository<TaxCollection> $taxRepository
     * @param EntityRepository<CountryCollection> $countryRepository
     * @param EntityRepository<CountryStateCollection> $countryStateRepository
     */
    public function __construct(
        private readonly EntityRepository $orderRepository,
        private readonly EntityRepository $customerAddressRepository,
        private readonly EntityRepository $taxRepository,
        private readonly EntityRepository $countryRepository,
        private readonly EntityRepository $countryStateRepository,
        private readonly EntityRepository $orderDeliveryRepository,
        private readonly EntityRepository $orderDeliveryPositionRepository,
        private readonly EntityRepository $orderLineItemRepository,
        private readonly OrderConverter $orderConverter,
        private readonly DestinationTaxResolver $taxResolver,
        private readonly QuantityPriceCalculator $priceCalculator,
        private readonly PercentageTaxRuleBuilder $taxRuleBuilder,
        private readonly AmountCalculator $amountCalculator,
        private readonly InitialStateIdLoader $initialStateIdLoader,
        private readonly LineItemFactoryRegistry $lineItemFactory,
        private readonly Processor $cartProcessor,
    ) {
    }

    /**
     * The order's shipments as the editor shows them.
     *
     * @return array<string, mixed>
     */
    public function describe(string $orderId, Context $context): array
    {
        $order = $this->fetchOrder($orderId, $context);
        $deliveries = $this->sortedDeliveries($order);

        $lines = [];
        foreach ($this->shippableLines($order) as $line) {
            $lines[] = [
                'id' => $line->getId(),
                'productId' => $line->getProductId(),
                'label' => $line->getLabel(),
                'productNumber' => $line->getPayload()['productNumber'] ?? null,
                'quantity' => $line->getQuantity(),
                'unitPrice' => $line->getPriceDefinition() instanceof QuantityPriceDefinition
                    ? $line->getPriceDefinition()->getPrice()
                    : $line->getUnitPrice(),
            ];
        }

        $shipments = [];
        foreach ($deliveries as $delivery) {
            $quantities = [];
            foreach ($delivery->getPositions() ?? [] as $position) {
                $lineId = $position->getOrderLineItemId();
                $quantities[$lineId] = ($quantities[$lineId] ?? 0) + $position->getQuantity();
            }

            $shipments[] = [
                'id' => $delivery->getId(),
                'primary' => $delivery->getId() === $order->getPrimaryOrderDeliveryId(),
                'shippingCost' => $delivery->getShippingCosts()->getUnitPrice(),
                'shippingMethod' => $delivery->getShippingMethod()?->getTranslation('name'),
                'state' => $delivery->getStateMachineState()?->getTranslation('name'),
                'address' => $this->addressData($delivery->getShippingOrderAddress()),
                'quantities' => $quantities,
            ];
        }

        $customerAddresses = [];
        $customerId = $order->getOrderCustomer()?->getCustomerId();
        if ($customerId !== null) {
            $criteria = (new Criteria())
                ->addFilter(new EqualsFilter('customerId', $customerId))
                ->addAssociation('country')
                ->addAssociation('countryState');
            foreach ($this->customerAddressRepository->search($criteria, $context)->getEntities() as $address) {
                $customerAddresses[] = $this->addressData($address);
            }
        }

        // States of the countries in play, for address editing.
        $countryIds = array_values(array_unique(array_filter(array_merge(
            array_map(static fn (array $shipment) => $shipment['address']['countryId'] ?? null, $shipments),
            array_map(static fn (array $address) => $address['countryId'] ?? null, $customerAddresses)
        ))));
        $countryStates = [];
        if ($countryIds !== []) {
            $criteria = (new Criteria())->addFilter(new EqualsAnyFilter('countryId', $countryIds));
            foreach ($this->countryStateRepository->search($criteria, $context)->getEntities() as $state) {
                $countryStates[] = [
                    'id' => $state->getId(),
                    'countryId' => $state->getCountryId(),
                    'shortCode' => $state->getShortCode(),
                    'name' => $state->getTranslation('name'),
                ];
            }
            usort($countryStates, static fn (array $a, array $b) => strcmp((string) $a['name'], (string) $b['name']));
        }

        return [
            'orderId' => $order->getId(),
            'taxStatus' => $order->getTaxStatus(),
            'currency' => $order->getCurrency()?->getIsoCode(),
            'lineItems' => $lines,
            'shipments' => $shipments,
            'customerAddresses' => $customerAddresses,
            'countryStates' => $countryStates,
        ];
    }

    /**
     * Applies a shipment plan and reprices the order.
     *
     * Plan:
     *  lineItems: { <orderLineItemId>: { unitPrice?: float } }
     *  newLineItems: [ { productId, unitPrice?: float } ]   products to add; priced like
     *                                    Shopware's "add product to order" unless unitPrice is set

     *  shipments: [ {
     *      id?: <orderDeliveryId>            existing shipment; omit to add one
     *      shippingCost: float               the shipment's charge, in the order's tax mode
     *      address:                          one of
     *          { customerAddressId }         copy a saved address of the customer
     *          { id?, ...fields }            edit the shipment's address (id = its order address)
     *      quantities: { <orderLineItemId or new productId>: int }
     *  } ]
     * Shipments left out are removed; a line with no units left is removed.
     *
     * @param array<string, mixed> $plan
     */
    public function apply(string $orderId, array $plan, Context $context): void
    {
        $order = $this->fetchOrder($orderId, $context);
        $salesChannelContext = $this->orderConverter->assembleSalesChannelContext($order, $context);

        $lines = [];
        foreach ($this->shippableLines($order) as $line) {
            $lines[$line->getId()] = $line;
        }

        $shipmentPlans = $plan['shipments'] ?? null;
        if (!\is_array($shipmentPlans) || $shipmentPlans === []) {
            throw new BadRequestHttpException('An order needs at least one shipment.');
        }

        $existing = $order->getDeliveries();
        \assert($existing !== null);

        // Products to add become new lines, priced for this customer.
        $newLineData = [];
        $aliases = $this->addNewLines($plan, $shipmentPlans, $order, $salesChannelContext, $lines, $newLineData);

        // Unit prices.
        $unitPrices = [];
        foreach ($lines as $lineId => $line) {
            $definition = $line->getPriceDefinition();
            $price = $definition instanceof QuantityPriceDefinition ? $definition->getPrice() : $line->getUnitPrice();
            $requested = $plan['lineItems'][$lineId]['unitPrice'] ?? ($newLineData[$lineId]['requestedUnitPrice'] ?? null);
            if ($requested !== null) {
                if (!is_numeric($requested) || (float) $requested < 0) {
                    throw new BadRequestHttpException(\sprintf('Invalid unit price for "%s".', $line->getLabel()));
                }
                $price = (float) $requested;
            }
            $unitPrices[$lineId] = $price;
        }

        // Normalise shipments and resolve their addresses.
        $taxes = $this->loadTaxes($context);
        $countries = $this->loadCountries($context);
        $customerAddresses = $this->loadCustomerAddresses($shipmentPlans, $order, $context);

        $shipments = [];
        $totals = array_fill_keys(array_keys($lines), 0);
        $keptDeliveryIds = [];
        foreach (array_values($shipmentPlans) as $index => $shipmentPlan) {
            if (!\is_array($shipmentPlan)) {
                throw new BadRequestHttpException('Invalid shipment.');
            }

            $deliveryId = $shipmentPlan['id'] ?? null;
            $delivery = null;
            if ($deliveryId !== null) {
                $delivery = $existing->get($deliveryId);
                if ($delivery === null) {
                    throw new BadRequestHttpException(\sprintf('Shipment %d does not belong to this order.', $index + 1));
                }
                $keptDeliveryIds[] = $deliveryId;
            }

            $cost = $shipmentPlan['shippingCost'] ?? ($delivery?->getShippingCosts()->getUnitPrice() ?? 0.0);
            if (!is_numeric($cost) || (float) $cost < 0) {
                throw new BadRequestHttpException(\sprintf('Invalid shipping cost for shipment %d.', $index + 1));
            }

            $quantities = [];
            foreach ((array) ($shipmentPlan['quantities'] ?? []) as $lineId => $quantity) {
                $lineId = $aliases[$lineId] ?? $lineId;
                if (!isset($lines[$lineId])) {
                    throw new BadRequestHttpException('Unknown line item in shipment ' . ($index + 1) . '.');
                }
                if (!is_numeric($quantity) || (int) $quantity < 0 || (int) $quantity != $quantity) {
                    throw new BadRequestHttpException(\sprintf('Invalid quantity for "%s".', $lines[$lineId]->getLabel()));
                }
                if ((int) $quantity > 0) {
                    $quantities[$lineId] = (int) $quantity;
                    $totals[$lineId] += (int) $quantity;
                }
            }
            if ($quantities === []) {
                throw new BadRequestHttpException(\sprintf('Shipment %d has no items. Remove it or add items.', $index + 1));
            }

            $address = $this->resolveAddress(
                \is_array($shipmentPlan['address'] ?? null) ? $shipmentPlan['address'] : [],
                $delivery,
                $order,
                $customerAddresses,
                $index
            );
            $country = $countries->get($address['countryId']);
            if (!$country instanceof CountryEntity) {
                throw new BadRequestHttpException(\sprintf('Shipment %d has no valid country.', $index + 1));
            }

            $shipments[] = [
                'delivery' => $delivery,
                'id' => $deliveryId ?? Uuid::randomHex(),
                'cost' => (float) $cost,
                'quantities' => $quantities,
                'address' => $address,
                'location' => $this->location($address, $country),
            ];
        }

        if (\count(array_unique($keptDeliveryIds)) !== \count($keptDeliveryIds)) {
            throw new BadRequestHttpException('A shipment is listed twice.');
        }

        // Price each line's share per shipment.
        $customer = $salesChannelContext->getCustomer();
        $sharePrices = [];
        foreach ($shipments as $shipmentIndex => $shipment) {
            foreach ($shipment['quantities'] as $lineId => $quantity) {
                $line = $lines[$lineId];
                $rules = $this->baseTaxRules($line);
                $taxId = $line->getPayload()['taxId'] ?? null;
                if (\is_string($taxId)) {
                    $rules = $this->taxResolver->resolve($taxes, $taxId, $shipment['location'], $customer) ?? $rules;
                }
                $sharePrices[$shipmentIndex][$lineId] = $this->priceCalculator->calculate(
                    new QuantityPriceDefinition($unitPrices[$lineId], $rules, $quantity),
                    $salesChannelContext
                );
            }
        }

        // Line items.
        $lineItemData = [];
        $removedLineIds = [];
        $linePrices = new PriceCollection();
        foreach ($lines as $lineId => $line) {
            if ($totals[$lineId] === 0) {
                $removedLineIds[] = $lineId;
                continue;
            }

            $shares = [];
            foreach ($sharePrices as $shipmentIndex => $byLine) {
                if (isset($byLine[$lineId])) {
                    $shares[$shipmentIndex] = $byLine[$lineId];
                }
            }
            $price = SplitPriceMerger::merge($shares, $totals[$lineId]);
            $linePrices->add($price);

            $row = [
                'id' => $lineId,
                'quantity' => $totals[$lineId],
                'price' => $price,
                'priceDefinition' => new QuantityPriceDefinition($unitPrices[$lineId], $this->baseTaxRules($line), $totals[$lineId]),
            ];
            if (isset($newLineData[$lineId])) {
                $row += $newLineData[$lineId]['data'];
            }
            $lineItemData[] = $row;
        }

        foreach ($order->getLineItems() ?? [] as $other) {
            if (!isset($lines[$other->getId()]) && $other->getParentId() === null && $other->getPrice() !== null) {
                $linePrices->add($other->getPrice());
            }
        }

        // Shipments: positions, shipping costs, addresses.
        $openStateId = $this->initialStateIdLoader->get(OrderDeliveryStates::STATE_MACHINE);
        $template = $this->sortedDeliveries($order)[0] ?? null;

        $deliveryData = [];
        $addressData = [];
        $shippingPrices = new PriceCollection();
        foreach ($shipments as $shipmentIndex => $shipment) {
            $positions = [];
            $positionPrices = new PriceCollection();
            foreach ($sharePrices[$shipmentIndex] as $lineId => $price) {
                $positionPrices->add($price);
                $positions[] = [
                    'id' => Uuid::randomHex(),
                    'orderLineItemId' => $lineId,
                    'orderLineItemVersionId' => $context->getVersionId(),
                    'price' => $price,
                ];
            }

            $shippingRules = $positionPrices->count() > 0
                ? $this->taxRuleBuilder->buildCollectionRules(
                    $positionPrices->getCalculatedTaxes(),
                    $positionPrices->sum()->getTotalPrice()
                )
                : new TaxRuleCollection();
            $shippingPrice = $this->priceCalculator->calculate(
                new QuantityPriceDefinition($shipment['cost'], $shippingRules, 1),
                $salesChannelContext
            );
            $shippingPrices->add($shippingPrice);

            $address = $shipment['address'];
            $addressData[] = ['orderId' => $order->getId()] + $address;

            /** @var OrderDeliveryEntity|null $delivery */
            $delivery = $shipment['delivery'];
            $row = [
                'id' => $shipment['id'],
                'shippingOrderAddressId' => $address['id'],
                'shippingCosts' => $shippingPrice,
                'positions' => $positions,
            ];
            if ($delivery === null) {
                $source = $template;
                $row += [
                    'stateId' => $openStateId,
                    'shippingMethodId' => $source?->getShippingMethodId() ?? $order->getPrimaryOrderDelivery()?->getShippingMethodId(),
                    'shippingDateEarliest' => ($source?->getShippingDateEarliest() ?? new \DateTimeImmutable())->format('Y-m-d H:i:s.v'),
                    'shippingDateLatest' => ($source?->getShippingDateLatest() ?? new \DateTimeImmutable('+3 days'))->format('Y-m-d H:i:s.v'),
                ];
            }
            $deliveryData[] = $row;
        }

        $price = $this->amountCalculator->calculate($linePrices, $shippingPrices, $salesChannelContext);
        $primaryId = \in_array($order->getPrimaryOrderDeliveryId(), $keptDeliveryIds, true)
            ? $order->getPrimaryOrderDeliveryId()
            : $shipments[0]['id'];

        $orderData = [
            'id' => $order->getId(),
            'price' => $price,
            'shippingCosts' => $shippingPrices->sum(),
            'addresses' => $addressData,
            'lineItems' => $lineItemData,
            'deliveries' => $deliveryData,
            'primaryOrderDeliveryId' => $primaryId,
        ];

        $transactionId = $order->getPrimaryOrderTransactionId() ?? $order->getTransactions()?->first()?->getId();
        if ($transactionId !== null) {
            $orderData['transactions'] = [[
                'id' => $transactionId,
                'amount' => new CalculatedPrice(
                    $price->getTotalPrice(),
                    $price->getTotalPrice(),
                    $price->getCalculatedTaxes(),
                    $price->getTaxRules()
                ),
            ]];
        }

        $removedDeliveryIds = array_values(array_diff($existing->getKeys(), $keptDeliveryIds));
        $oldPositionIds = [];
        foreach ($existing as $delivery) {
            if (\in_array($delivery->getId(), $removedDeliveryIds, true)) {
                continue;
            }
            foreach ($delivery->getPositions() ?? [] as $position) {
                $oldPositionIds[] = ['id' => $position->getId()];
            }
        }

        $context->scope(Context::SYSTEM_SCOPE, function (Context $context) use ($oldPositionIds, $removedDeliveryIds, $removedLineIds, $orderData): void {
            if ($oldPositionIds !== []) {
                $this->orderDeliveryPositionRepository->delete($oldPositionIds, $context);
            }
            if ($removedDeliveryIds !== []) {
                $this->orderDeliveryRepository->delete(array_map(static fn (string $id) => ['id' => $id], $removedDeliveryIds), $context);
            }
            if ($removedLineIds !== []) {
                $this->orderLineItemRepository->delete(array_map(static fn (string $id) => ['id' => $id], $removedLineIds), $context);
            }
            $this->orderRepository->upsert([$orderData], $context);
        });
    }

    /**
     * Prices the products in plan.newLineItems for the order's customer (customer
     * group prices, tier prices, stock limits, the product's tax), the way Shopware
     * adds a product to an existing order, and registers each as a new line.
     *
     * @param array<string, mixed> $plan
     * @param array<mixed> $shipmentPlans
     * @param array<string, OrderLineItemEntity> $lines new lines are added here
     * @param array<string, array<string, mixed>> $newLineData write data per new line id
     *
     * @return array<string, string> productId => new line id, for plan quantities
     */
    private function addNewLines(
        array $plan,
        array $shipmentPlans,
        OrderEntity $order,
        SalesChannelContext $salesChannelContext,
        array &$lines,
        array &$newLineData
    ): array {
        $requested = [];
        foreach ((array) ($plan['newLineItems'] ?? []) as $item) {
            $productId = \is_array($item) ? ($item['productId'] ?? null) : null;
            if (!\is_string($productId) || !Uuid::isValid($productId)) {
                throw new BadRequestHttpException('Invalid product to add.');
            }
            foreach ($lines as $line) {
                if ($line->getProductId() === $productId) {
                    throw new BadRequestHttpException(\sprintf('"%s" is already on the order; change its units instead.', $line->getLabel()));
                }
            }
            $unitPrice = $item['unitPrice'] ?? null;
            if ($unitPrice !== null && (!is_numeric($unitPrice) || (float) $unitPrice < 0)) {
                throw new BadRequestHttpException('Invalid unit price for a new item.');
            }
            $requested[$productId] = ['quantity' => 0, 'unitPrice' => $unitPrice];
        }
        if ($requested === []) {
            return [];
        }

        foreach ($shipmentPlans as $shipmentPlan) {
            foreach ((array) (\is_array($shipmentPlan) ? ($shipmentPlan['quantities'] ?? []) : []) as $key => $quantity) {
                if (isset($requested[$key]) && is_numeric($quantity)) {
                    $requested[$key]['quantity'] += max(0, (int) $quantity);
                }
            }
        }

        $priced = $salesChannelContext->live(function (SalesChannelContext $live) use ($requested): Cart {
            $cart = new Cart(Uuid::randomHex());
            foreach ($requested as $productId => $item) {
                if ($item['quantity'] <= 0) {
                    continue;
                }
                $cart->add($this->lineItemFactory->create([
                    'id' => $productId,
                    'referencedId' => $productId,
                    'type' => LineItem::PRODUCT_LINE_ITEM_TYPE,
                    'quantity' => $item['quantity'],
                ], $live));
            }

            return $this->cartProcessor->process($cart, $live, new CartBehavior($live->getPermissions()));
        });

        $position = 0;
        foreach ($lines as $line) {
            $position = max($position, $line->getPosition());
        }

        $aliases = [];
        foreach ($requested as $productId => $item) {
            if ($item['quantity'] <= 0) {
                throw new BadRequestHttpException('A new item has no units in any shipment.');
            }
            $lineItem = $priced->getLineItems()->get($productId);
            if ($lineItem === null || !$lineItem->getPriceDefinition() instanceof QuantityPriceDefinition) {
                throw new BadRequestHttpException('A product to add is not available for this customer.');
            }
            if ($lineItem->getQuantity() < $item['quantity']) {
                throw new BadRequestHttpException(\sprintf(
                    '"%s": only %d can be ordered (stock or order limits).',
                    $lineItem->getLabel(),
                    $lineItem->getQuantity()
                ));
            }

            $id = Uuid::randomHex();
            $data = LineItemTransformer::transform($lineItem, null, ++$position);
            $data = reset($data);
            \assert(\is_array($data));
            unset($data['id'], $data['quantity'], $data['price'], $data['priceDefinition']);
            $data['identifier'] = $id;

            $entity = new OrderLineItemEntity();
            $entity->setId($id);
            $entity->setIdentifier($id);
            $entity->setLabel((string) $lineItem->getLabel());
            $entity->setType(LineItem::PRODUCT_LINE_ITEM_TYPE);
            $entity->setProductId($productId);
            $entity->setReferencedId($productId);
            $entity->setQuantity($item['quantity']);
            $entity->setPayload($lineItem->getPayload());
            $entity->setPriceDefinition($lineItem->getPriceDefinition());
            $entity->setPrice($lineItem->getPrice());
            $entity->setGood(true);
            $entity->setPosition($position);

            $lines[$id] = $entity;
            $newLineData[$id] = ['data' => $data, 'requestedUnitPrice' => $item['unitPrice']];
            $aliases[$productId] = $id;
        }

        return $aliases;
    }

    private function fetchOrder(string $orderId, Context $context): OrderEntity
    {
        $criteria = (new Criteria([$orderId]))->addAssociations([
            'currency',
            'lineItems',
            'transactions.stateMachineState',
            'orderCustomer',
            'primaryOrderDelivery',
            'deliveries.positions',
            'deliveries.shippingMethod',
            'deliveries.stateMachineState',
            'deliveries.shippingOrderAddress.country',
            'deliveries.shippingOrderAddress.countryState',
        ]);

        $order = $this->orderRepository->search($criteria, $context)->getEntities()->first();
        if (!$order instanceof OrderEntity) {
            throw new NotFoundHttpException(\sprintf('Order %s not found.', $orderId));
        }

        return $order;
    }

    /**
     * Primary delivery first, then the rest in a stable order.
     *
     * @return list<OrderDeliveryEntity>
     */
    private function sortedDeliveries(OrderEntity $order): array
    {
        $deliveries = array_values($order->getDeliveries()?->getElements() ?? []);
        $primaryId = $order->getPrimaryOrderDeliveryId();
        usort($deliveries, static function (OrderDeliveryEntity $a, OrderDeliveryEntity $b) use ($primaryId): int {
            if ($a->getId() === $primaryId) {
                return -1;
            }
            if ($b->getId() === $primaryId) {
                return 1;
            }

            return strcmp(
                (string) $a->getShippingOrderAddress()?->getCity() . $a->getId(),
                (string) $b->getShippingOrderAddress()?->getCity() . $b->getId()
            );
        });

        return $deliveries;
    }

    /**
     * Top-level lines that ship: products and custom items.
     *
     * @return list<OrderLineItemEntity>
     */
    private function shippableLines(OrderEntity $order): array
    {
        $lines = [];
        foreach ($order->getLineItems() ?? [] as $line) {
            if ($line->getParentId() === null && $line->getGood() && \in_array($line->getType(), ['product', 'custom'], true)) {
                $lines[] = $line;
            }
        }
        usort($lines, static fn (OrderLineItemEntity $a, OrderLineItemEntity $b) => $a->getPosition() <=> $b->getPosition());

        return $lines;
    }

    private function baseTaxRules(OrderLineItemEntity $line): TaxRuleCollection
    {
        $definition = $line->getPriceDefinition();
        if ($definition instanceof QuantityPriceDefinition) {
            return $definition->getTaxRules();
        }

        return $line->getPrice()?->getTaxRules() ?? new TaxRuleCollection();
    }

    /**
     * The address a shipment ships to, as order address data (with id).
     *
     * @param array<string, mixed> $input
     *
     * @return array<string, mixed>
     */
    private function resolveAddress(
        array $input,
        ?OrderDeliveryEntity $delivery,
        OrderEntity $order,
        CustomerAddressCollection $customerAddresses,
        int $index
    ): array {
        $customerAddressId = $input['customerAddressId'] ?? null;
        if (\is_string($customerAddressId)) {
            $address = $customerAddresses->get($customerAddressId);
            if (!$address instanceof CustomerAddressEntity) {
                throw new BadRequestHttpException(\sprintf('Shipment %d: the address is not one of the customer\'s addresses.', $index + 1));
            }

            // Reuse the shipment's own order address when it is the same saved address.
            $current = $delivery?->getShippingOrderAddress();
            $data = ['id' => Uuid::randomHex()];
            foreach (self::ADDRESS_FIELDS as $field) {
                $data[$field] = self::field($address, $field);
            }
            if ($current !== null && $this->sameAddress($current, $data)) {
                $data['id'] = $current->getId();
            }

            return $data;
        }

        $current = $delivery?->getShippingOrderAddress();
        $data = ['id' => $current?->getId() ?? Uuid::randomHex()];
        foreach (self::ADDRESS_FIELDS as $field) {
            $data[$field] = $current !== null ? self::field($current, $field) : null;
        }
        foreach (self::EDITABLE_ADDRESS_FIELDS as $field) {
            if (\array_key_exists($field, $input)) {
                $value = $input[$field];
                $data[$field] = \is_string($value) ? (trim($value) === '' ? null : trim($value)) : $value;
            }
        }
        // A new shipment without an address starts from the order's primary one.
        if ($current === null) {
            $primary = $order->getPrimaryOrderDelivery()?->getShippingOrderAddressId();
            $source = $primary !== null ? $order->getDeliveries()?->filterByProperty('shippingOrderAddressId', $primary)->first()?->getShippingOrderAddress() : null;
            foreach (self::ADDRESS_FIELDS as $field) {
                $data[$field] ??= ($source !== null ? self::field($source, $field) : null);
            }
        }

        // An edited address gets its own row: the old one may also be the billing
        // address or another shipment's address.
        if ($current !== null && !$this->sameAddress($current, $data)) {
            $data['id'] = Uuid::randomHex();
        }

        foreach (['firstName', 'lastName', 'street', 'city', 'countryId'] as $required) {
            if (!\is_string($data[$required] ?? null) || $data[$required] === '') {
                throw new BadRequestHttpException(\sprintf('Shipment %d: the address needs %s.', $index + 1, $required));
            }
        }

        return $data;
    }

    /**
     * @param array<string, mixed> $data
     */
    private function sameAddress(OrderAddressEntity $current, array $data): bool
    {
        foreach (self::ADDRESS_FIELDS as $field) {
            if (self::field($current, $field) !== $data[$field]) {
                return false;
            }
        }

        return true;
    }

    /**
     * @param array<string, mixed> $address
     */
    private function location(array $address, CountryEntity $country): ShippingLocation
    {
        $state = null;
        if (\is_string($address['countryStateId'] ?? null)) {
            $state = $country->getStates()?->get($address['countryStateId']);
        }

        // The tax rule filters read the zip code from a customer address.
        $customerAddress = new CustomerAddressEntity();
        $customerAddress->setId((string) $address['id']);
        $customerAddress->setZipcode((string) ($address['zipcode'] ?? ''));
        $customerAddress->setCountryId($country->getId());
        $customerAddress->setCountry($country);
        if ($state !== null) {
            $customerAddress->setCountryStateId($state->getId());
            $customerAddress->setCountryState($state);
        }

        return new ShippingLocation($country, $state, $customerAddress);
    }

    private static function field(OrderAddressEntity|CustomerAddressEntity $address, string $field): mixed
    {
        return $address->getVars()[$field] ?? null;
    }

    private function loadTaxes(Context $context): TaxCollection
    {
        $criteria = (new Criteria())->addAssociation('rules.type');

        return $this->taxRepository->search($criteria, $context)->getEntities();
    }

    private function loadCountries(Context $context): CountryCollection
    {
        // Small table; load every country with its states.
        $criteria = (new Criteria())->addAssociation('states');

        return $this->countryRepository->search($criteria, $context)->getEntities();
    }

    /**
     * @param array<mixed> $shipmentPlans
     */
    private function loadCustomerAddresses(array $shipmentPlans, OrderEntity $order, Context $context): CustomerAddressCollection
    {
        $ids = [];
        foreach ($shipmentPlans as $shipmentPlan) {
            $id = \is_array($shipmentPlan) ? ($shipmentPlan['address']['customerAddressId'] ?? null) : null;
            if (\is_string($id) && Uuid::isValid($id)) {
                $ids[] = $id;
            }
        }
        $customerId = $order->getOrderCustomer()?->getCustomerId();
        if ($ids === [] || $customerId === null) {
            return new CustomerAddressCollection();
        }

        $criteria = (new Criteria(array_values(array_unique($ids))))
            ->addFilter(new EqualsFilter('customerId', $customerId));

        return $this->customerAddressRepository->search($criteria, $context)->getEntities();
    }

    /**
     * @return array<string, mixed>|null
     */
    private function addressData(OrderAddressEntity|CustomerAddressEntity|null $address): ?array
    {
        if ($address === null) {
            return null;
        }

        $data = ['id' => $address->getId()];
        foreach (self::ADDRESS_FIELDS as $field) {
            $data[$field] = self::field($address, $field);
        }
        $data['countryName'] = $address->getCountry()?->getTranslation('name');
        $data['countryStateCode'] = $address->getCountryState()?->getShortCode();
        $data['countryStateName'] = $address->getCountryState()?->getTranslation('name');

        return $data;
    }
}

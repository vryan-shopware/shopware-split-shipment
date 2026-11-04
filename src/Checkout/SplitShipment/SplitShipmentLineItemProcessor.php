<?php declare(strict_types=1);

namespace DemoSplitShipment\Checkout\SplitShipment;

use Shopware\Core\Checkout\Cart\Cart;
use Shopware\Core\Checkout\Cart\CartBehavior;
use Shopware\Core\Checkout\Cart\CartDataCollectorInterface;
use Shopware\Core\Checkout\Cart\CartProcessorInterface;
use Shopware\Core\Checkout\Cart\Delivery\Struct\ShippingLocation;
use Shopware\Core\Checkout\Cart\LineItem\CartDataCollection;
use Shopware\Core\Checkout\Cart\LineItem\LineItem;
use Shopware\Core\Checkout\Cart\Price\QuantityPriceCalculator;
use Shopware\Core\Checkout\Cart\Price\Struct\QuantityPriceDefinition;
use Shopware\Core\Checkout\Customer\Aggregate\CustomerAddress\CustomerAddressCollection;
use Shopware\Core\Checkout\Customer\Aggregate\CustomerAddress\CustomerAddressEntity;
use Shopware\Core\Framework\DataAbstractionLayer\EntityRepository;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Criteria;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Filter\EqualsFilter;
use Shopware\Core\System\SalesChannel\SalesChannelContext;
use Shopware\Core\System\Tax\TaxCollection;

/**
 * Prices each cart line per destination. A line whose units go to several addresses
 * is split into one share per destination; each share is priced with the tax rules of
 * its own ship-to location, and the line's price becomes the sum of the shares (so it
 * can carry several tax rates). Runs right after products are priced (priority 5000)
 * and before promotions and deliveries, which then see the per-destination taxes.
 */
class SplitShipmentLineItemProcessor implements CartDataCollectorInterface, CartProcessorInterface
{
    public const ADDRESSES_KEY = 'split-shipment-addresses';
    public const TAXES_KEY = 'split-shipment-taxes';

    /**
     * @param EntityRepository<CustomerAddressCollection> $addressRepository
     * @param EntityRepository<TaxCollection> $taxRepository
     */
    public function __construct(
        private readonly SplitShipmentConfig $config,
        private readonly EntityRepository $addressRepository,
        private readonly EntityRepository $taxRepository,
        private readonly DestinationTaxResolver $taxResolver,
        private readonly QuantityPriceCalculator $priceCalculator
    ) {
    }

    public function collect(CartDataCollection $data, Cart $original, SalesChannelContext $context, CartBehavior $behavior): void
    {
        $allocations = $this->allocations($original, $context);
        $customer = $context->getCustomer();
        if ($allocations === null || $customer === null) {
            return;
        }

        $criteria = new Criteria($allocations->getAddressIds());
        $criteria->addFilter(new EqualsFilter('customerId', $customer->getId()));
        $criteria->addAssociation('country');
        $criteria->addAssociation('countryState');
        $criteria->addAssociation('salutation');
        $criteria->setTitle('split-shipment::addresses');
        $data->set(self::ADDRESSES_KEY, $this->addressRepository->search($criteria, $context->getContext())->getEntities());

        if (!$data->has(self::TAXES_KEY)) {
            $taxCriteria = new Criteria();
            $taxCriteria->addAssociation('rules.type');
            $taxCriteria->setTitle('split-shipment::taxes');
            $data->set(self::TAXES_KEY, $this->taxRepository->search($taxCriteria, $context->getContext())->getEntities());
        }
    }

    public function process(CartDataCollection $data, Cart $original, Cart $toCalculate, SalesChannelContext $context, CartBehavior $behavior): void
    {
        $allocations = $this->allocations($original, $context);
        $addresses = $data->get(self::ADDRESSES_KEY);
        $taxes = $data->get(self::TAXES_KEY);
        if ($allocations === null || !$addresses instanceof CustomerAddressCollection || !$taxes instanceof TaxCollection) {
            return;
        }

        $primaryAddressId = $context->getShippingLocation()->getAddress()?->getId();
        $maxDestinations = $this->config->getMaxDestinations($context->getSalesChannelId());

        foreach ($toCalculate->getLineItems() as $lineItem) {
            $lineItem->removeExtension(SplitShipmentLinePrices::EXTENSION_NAME);

            $quantities = $this->destinationQuantities(
                $lineItem,
                $allocations->getForLineItem($lineItem->getId()),
                $addresses,
                $primaryAddressId,
                $maxDestinations
            );
            if ($quantities === null) {
                continue;
            }

            $definition = $lineItem->getPriceDefinition();
            $taxId = $lineItem->getPayloadValue('taxId');
            if (!$definition instanceof QuantityPriceDefinition || !\is_string($taxId)) {
                continue;
            }

            $prices = [];
            foreach ($quantities as $key => $quantity) {
                if ($key === SplitShipmentLinePrices::PRIMARY) {
                    $rules = $definition->getTaxRules();
                } else {
                    $address = $addresses->get($key);
                    \assert($address instanceof CustomerAddressEntity);
                    $rules = $this->taxResolver->resolve($taxes, $taxId, ShippingLocation::createFromAddress($address), $context->getCustomer())
                        ?? $definition->getTaxRules();
                }

                $share = new QuantityPriceDefinition($definition->getPrice(), $rules, $quantity);
                $share->setIsCalculated($definition->isCalculated());
                $share->setListPrice($definition->getListPrice());
                $share->setRegulationPrice($definition->getRegulationPrice());
                $share->setReferencePriceDefinition($definition->getReferencePriceDefinition());

                $prices[$key] = $this->priceCalculator->calculate($share, $context);
            }

            $lineItem->setPrice(SplitPriceMerger::merge($prices, $lineItem->getQuantity()));
            $lineItem->addExtension(SplitShipmentLinePrices::EXTENSION_NAME, new SplitShipmentLinePrices($quantities, $prices));
        }
    }

    /**
     * Destination key => quantity for one line, or null when everything ships to the
     * primary address. Unknown addresses are ignored; assignments larger than the line
     * are trimmed in order; the rest ships to the primary address.
     *
     * @param array<string, int> $requested
     *
     * @return array<string, int>|null
     */
    private function destinationQuantities(
        LineItem $lineItem,
        array $requested,
        CustomerAddressCollection $addresses,
        ?string $primaryAddressId,
        int $maxDestinations
    ): ?array {
        if ($requested === [] || !$lineItem->isStackable() || $lineItem->getType() !== LineItem::PRODUCT_LINE_ITEM_TYPE) {
            return null;
        }

        $remaining = $lineItem->getQuantity();
        $quantities = [];

        foreach ($requested as $addressId => $quantity) {
            $quantity = min((int) $quantity, $remaining);
            if ($quantity <= 0 || !$addresses->has($addressId)) {
                continue;
            }
            if ($addressId === $primaryAddressId) {
                continue;
            }
            if (!isset($quantities[$addressId]) && \count($quantities) + 1 >= $maxDestinations) {
                continue;
            }

            $quantities[$addressId] = ($quantities[$addressId] ?? 0) + $quantity;
            $remaining -= $quantity;
        }

        if ($quantities === []) {
            return null;
        }

        if ($remaining > 0) {
            $quantities = [SplitShipmentLinePrices::PRIMARY => $remaining] + $quantities;
        }

        return $quantities;
    }

    private function allocations(Cart $cart, SalesChannelContext $context): ?SplitShipmentAllocations
    {
        if (!$this->config->isEnabled($context->getSalesChannelId())) {
            return null;
        }

        $allocations = $cart->getExtension(SplitShipmentAllocations::EXTENSION_NAME);

        return $allocations instanceof SplitShipmentAllocations && !$allocations->isEmpty() ? $allocations : null;
    }
}

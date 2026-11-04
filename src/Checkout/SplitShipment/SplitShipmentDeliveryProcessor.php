<?php declare(strict_types=1);

namespace DemoSplitShipment\Checkout\SplitShipment;

use Shopware\Core\Checkout\Cart\Cart;
use Shopware\Core\Checkout\Cart\CartBehavior;
use Shopware\Core\Checkout\Cart\CartProcessorInterface;
use Shopware\Core\Checkout\Cart\Delivery\DeliveryCalculator;
use Shopware\Core\Checkout\Cart\Delivery\DeliveryProcessor;
use Shopware\Core\Checkout\Cart\Delivery\Struct\Delivery;
use Shopware\Core\Checkout\Cart\Delivery\Struct\DeliveryCollection;
use Shopware\Core\Checkout\Cart\Delivery\Struct\DeliveryPosition;
use Shopware\Core\Checkout\Cart\Delivery\Struct\DeliveryPositionCollection;
use Shopware\Core\Checkout\Cart\Delivery\Struct\ShippingLocation;
use Shopware\Core\Checkout\Cart\LineItem\CartDataCollection;
use Shopware\Core\Checkout\Cart\Price\QuantityPriceCalculator;
use Shopware\Core\Checkout\Cart\Price\Struct\CalculatedPrice;
use Shopware\Core\Checkout\Cart\Price\Struct\PriceCollection;
use Shopware\Core\Checkout\Cart\Price\Struct\QuantityPriceDefinition;
use Shopware\Core\Checkout\Cart\Tax\PercentageTaxRuleBuilder;
use Shopware\Core\Checkout\Cart\Tax\Struct\CalculatedTaxCollection;
use Shopware\Core\Checkout\Cart\Tax\Struct\TaxRuleCollection;
use Shopware\Core\Checkout\Customer\Aggregate\CustomerAddress\CustomerAddressCollection;
use Shopware\Core\Checkout\Customer\Aggregate\CustomerAddress\CustomerAddressEntity;
use Shopware\Core\System\SalesChannel\SalesChannelContext;

/**
 * Turns the cart's single delivery into one delivery per destination, after Shopware
 * built and priced the default delivery (priority -5000). Each delivery carries its
 * ship-to address, so the order gets one order delivery per address with its own
 * positions and shipping costs.
 *
 * Shipping, per the plugin settings:
 *  - single: the default delivery's cost (priced on the whole cart) goes on the first
 *    delivery; other destinations are free.
 *  - perDestination: every destination is priced as its own shipment with the shipping
 *    method's price matrix (quantity, price, weight or volume of that shipment).
 * An optional fee is added to every destination after the first. Shipping tax follows
 * the delivery's own lines, so it uses each destination's tax rates.
 */
class SplitShipmentDeliveryProcessor implements CartProcessorInterface
{
    public function __construct(
        private readonly SplitShipmentConfig $config,
        private readonly DeliveryCalculator $deliveryCalculator,
        private readonly QuantityPriceCalculator $priceCalculator,
        private readonly PercentageTaxRuleBuilder $percentageTaxRuleBuilder
    ) {
    }

    public function process(CartDataCollection $data, Cart $original, Cart $toCalculate, SalesChannelContext $context, CartBehavior $behavior): void
    {
        $salesChannelId = $context->getSalesChannelId();
        if (!$this->config->isEnabled($salesChannelId) || $behavior->hasPermission(DeliveryProcessor::SKIP_DELIVERY_PRICE_RECALCULATION)) {
            return;
        }

        $base = $toCalculate->getDeliveries()->first();
        $addresses = $data->get(SplitShipmentLineItemProcessor::ADDRESSES_KEY);
        if (!$base instanceof Delivery || !$addresses instanceof CustomerAddressCollection || !$this->hasSplitLines($base)) {
            return;
        }

        /** @var array<string, DeliveryPositionCollection> $groups */
        $groups = [SplitShipmentLinePrices::PRIMARY => new DeliveryPositionCollection()];

        foreach ($base->getPositions() as $position) {
            $lineItem = $position->getLineItem();
            $split = $lineItem->getExtension(SplitShipmentLinePrices::EXTENSION_NAME);

            if (!$split instanceof SplitShipmentLinePrices) {
                $groups[SplitShipmentLinePrices::PRIMARY]->add($position);

                continue;
            }

            foreach ($split->getQuantities() as $key => $quantity) {
                $price = $split->getPrices()[$key];

                // A copy of the line with only this destination's units and price: the
                // shipping matrix (weight, price) and shipping tax read the line items.
                $share = clone $lineItem;
                $share->setQuantity($quantity);
                $share->setPrice($price);

                $groups[$key] ??= new DeliveryPositionCollection();
                $groups[$key]->add(new DeliveryPosition($lineItem->getId(), $share, $quantity, $price, $position->getDeliveryDate()));
            }
        }

        $deliveries = [];
        foreach ($groups as $key => $positions) {
            if ($positions->count() === 0) {
                continue;
            }

            if ($key === SplitShipmentLinePrices::PRIMARY) {
                $location = $base->getLocation();
            } else {
                $address = $addresses->get($key);
                if (!$address instanceof CustomerAddressEntity) {
                    continue;
                }
                $location = ShippingLocation::createFromAddress($address);
            }

            $deliveries[] = new Delivery($positions, $base->getDeliveryDate(), $base->getShippingMethod(), $location, $this->zeroPrice());
        }

        if (\count($deliveries) < 2) {
            return;
        }

        $collection = new DeliveryCollection($deliveries);

        if ($this->config->getShippingCostMode($salesChannelId) === SplitShipmentConfig::MODE_SINGLE) {
            $deliveries[0]->setShippingCosts($base->getShippingCosts());
        } else {
            $this->deliveryCalculator->calculate($data, $toCalculate, $collection, $context);
        }

        $fee = $this->config->getAdditionalDestinationFee($salesChannelId) * $context->getContext()->getCurrencyFactor();
        if ($fee > 0) {
            foreach (\array_slice($deliveries, 1) as $delivery) {
                $delivery->setShippingCosts($this->addFee($delivery, $fee, $context));
            }
        }

        $toCalculate->setDeliveries($collection);
    }

    private function hasSplitLines(Delivery $delivery): bool
    {
        foreach ($delivery->getPositions() as $position) {
            if ($position->getLineItem()->hasExtension(SplitShipmentLinePrices::EXTENSION_NAME)) {
                return true;
            }
        }

        return false;
    }

    private function addFee(Delivery $delivery, float $fee, SalesChannelContext $context): CalculatedPrice
    {
        $positionPrices = $delivery->getPositions()->getPrices();
        $rules = $this->percentageTaxRuleBuilder->buildCollectionRules(
            $positionPrices->getCalculatedTaxes(),
            $positionPrices->getTotalPriceAmount()
        );

        $feePrice = $this->priceCalculator->calculate(new QuantityPriceDefinition($fee, $rules, 1), $context);

        return (new PriceCollection([$delivery->getShippingCosts(), $feePrice]))->sum();
    }

    private function zeroPrice(): CalculatedPrice
    {
        return new CalculatedPrice(0.0, 0.0, new CalculatedTaxCollection(), new TaxRuleCollection());
    }
}

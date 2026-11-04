<?php declare(strict_types=1);

namespace DemoSplitShipment\Checkout\SplitShipment;

use Shopware\Core\Checkout\Cart\Price\Struct\CalculatedPrice;
use Shopware\Core\Checkout\Cart\Tax\Struct\CalculatedTaxCollection;
use Shopware\Core\Checkout\Cart\Tax\Struct\TaxRule;
use Shopware\Core\Checkout\Cart\Tax\Struct\TaxRuleCollection;

/**
 * Combines the per-destination prices of one line into the line's price: totals and
 * taxes are summed, and the tax rules become each rate's share of the total, so one
 * line can carry several tax rates. Used by checkout and by the order editor.
 */
final class SplitPriceMerger
{
    /**
     * @param array<string, CalculatedPrice> $prices
     */
    public static function merge(array $prices, int $quantity): CalculatedPrice
    {
        $first = reset($prices);
        \assert($first instanceof CalculatedPrice);

        $total = 0.0;
        $taxes = new CalculatedTaxCollection();
        $byRate = [];
        $unitPrices = [];

        foreach ($prices as $price) {
            $total += $price->getTotalPrice();
            $taxes = $taxes->merge($price->getCalculatedTaxes());
            $unitPrices[(string) $price->getUnitPrice()] = true;
            foreach ($price->getTaxRules() as $rule) {
                $key = (string) $rule->getTaxRate();
                $byRate[$key] = ($byRate[$key] ?? 0.0) + $price->getTotalPrice() * $rule->getPercentage() / 100;
            }
        }

        $rules = new TaxRuleCollection();
        foreach ($byRate as $rate => $amount) {
            $rules->add(new TaxRule((float) $rate, $total > 0 ? $amount / $total * 100 : 100 / \count($byRate)));
        }

        // Net prices: the unit price is the same for every share. Gross prices differ
        // per tax rate, so the line shows the average.
        $unitPrice = \count($unitPrices) === 1 ? $first->getUnitPrice() : round($total / max(1, $quantity), 2);

        return new CalculatedPrice(
            $unitPrice,
            $total,
            $taxes,
            $rules,
            $quantity,
            $first->getReferencePrice(),
            $first->getListPrice(),
            $first->getRegulationPrice()
        );
    }
}

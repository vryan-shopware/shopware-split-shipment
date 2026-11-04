<?php declare(strict_types=1);

namespace DemoSplitShipment\Checkout\SplitShipment;

use Shopware\Core\Checkout\Cart\Delivery\Struct\ShippingLocation;
use Shopware\Core\Checkout\Cart\Tax\Struct\TaxRule;
use Shopware\Core\Checkout\Cart\Tax\Struct\TaxRuleCollection;
use Shopware\Core\Checkout\Customer\CustomerEntity;
use Shopware\Core\System\Tax\Aggregate\TaxRule\TaxRuleEntity;
use Shopware\Core\System\Tax\TaxCollection;
use Shopware\Core\System\Tax\TaxRuleType\TaxRuleTypeFilterInterface;

/**
 * Picks the tax rate for a tax (e.g. "Standard rate") at a given shipping location,
 * the same way Shopware builds the sales channel context: keep the tax rules whose
 * type matches the location (entire country, individual states, zip code, zip range),
 * take the most specific type, then the latest active rule. Falls back to the tax's
 * default rate when no rule matches.
 */
class DestinationTaxResolver
{
    /**
     * @param iterable<TaxRuleTypeFilterInterface> $taxRuleTypeFilters
     */
    public function __construct(private readonly iterable $taxRuleTypeFilters)
    {
    }

    public function resolve(TaxCollection $taxes, string $taxId, ShippingLocation $location, ?CustomerEntity $customer): ?TaxRuleCollection
    {
        $tax = $taxes->get($taxId);
        if ($tax === null) {
            return null;
        }

        $rate = $tax->getTaxRate();
        $rules = $tax->getRules();

        if ($rules !== null) {
            $matching = $rules->filter(function (TaxRuleEntity $rule) use ($customer, $location): bool {
                foreach ($this->taxRuleTypeFilters as $filter) {
                    if ($filter->match($rule, $customer, $location)) {
                        return true;
                    }
                }

                return false;
            });

            $mostSpecific = $matching->highestTypePosition();
            if ($mostSpecific !== null && $mostSpecific->getType() !== null) {
                $active = $matching->filterByTypePosition($mostSpecific->getType()->getPosition())->latestActivationDate();
                if ($active !== null) {
                    $rate = $active->getTaxRate();
                }
            }
        }

        return new TaxRuleCollection([new TaxRule($rate, 100)]);
    }
}

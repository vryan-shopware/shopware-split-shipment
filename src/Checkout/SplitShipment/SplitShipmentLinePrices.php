<?php declare(strict_types=1);

namespace DemoSplitShipment\Checkout\SplitShipment;

use Shopware\Core\Checkout\Cart\Price\Struct\CalculatedPrice;
use Shopware\Core\Framework\Struct\Struct;

/**
 * Line item extension written during price calculation: the line's share for each
 * destination, priced with that destination's tax rules. The delivery processor turns
 * these into per-destination delivery positions.
 */
class SplitShipmentLinePrices extends Struct
{
    public const EXTENSION_NAME = 'splitShipmentPrices';
    public const PRIMARY = 'primary';

    /**
     * @param array<string, int> $quantities destination key (PRIMARY or customerAddressId) => quantity
     * @param array<string, CalculatedPrice> $prices destination key => price for that quantity
     */
    public function __construct(
        protected array $quantities,
        protected array $prices
    ) {
    }

    /**
     * @return array<string, int>
     */
    public function getQuantities(): array
    {
        return $this->quantities;
    }

    /**
     * @return array<string, CalculatedPrice>
     */
    public function getPrices(): array
    {
        return $this->prices;
    }

    public function getApiAlias(): string
    {
        return 'split_shipment_line_prices';
    }
}

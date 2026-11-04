<?php declare(strict_types=1);

namespace DemoSplitShipment\Checkout\SplitShipment;

use Shopware\Core\Framework\Struct\Struct;

/**
 * Cart extension holding the buyer's choices: for a cart line, how many units go to
 * which of their saved addresses. Units not assigned ship to the checkout's shipping
 * address (the "primary" destination).
 *
 * Stored on the cart, so it is persisted with it and returned by the Store API as
 * cart.extensions.splitShipment.
 */
class SplitShipmentAllocations extends Struct
{
    public const EXTENSION_NAME = 'splitShipment';

    /**
     * @param array<string, array<string, int>> $allocations lineItemId => [customerAddressId => quantity]
     */
    public function __construct(protected array $allocations = [])
    {
    }

    /**
     * @return array<string, array<string, int>>
     */
    public function getAllocations(): array
    {
        return $this->allocations;
    }

    /**
     * @return array<string, int>
     */
    public function getForLineItem(string $lineItemId): array
    {
        return $this->allocations[$lineItemId] ?? [];
    }

    public function isEmpty(): bool
    {
        return $this->allocations === [];
    }

    /**
     * @return list<string>
     */
    public function getAddressIds(): array
    {
        $ids = [];
        foreach ($this->allocations as $byAddress) {
            foreach (array_keys($byAddress) as $addressId) {
                $ids[$addressId] = true;
            }
        }

        return array_keys($ids);
    }

    public function getApiAlias(): string
    {
        return 'split_shipment_allocations';
    }
}

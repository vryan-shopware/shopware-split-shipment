<?php declare(strict_types=1);

namespace DemoSplitShipment\Checkout\SplitShipment;

use Shopware\Core\System\SystemConfig\SystemConfigService;

/**
 * Reads the plugin settings (Settings → Extensions → Split shipments), per sales channel.
 */
class SplitShipmentConfig
{
    public const MODE_SINGLE = 'single';
    public const MODE_PER_DESTINATION = 'perDestination';

    private const PREFIX = 'DemoSplitShipment.config.';

    public function __construct(private readonly SystemConfigService $systemConfig)
    {
    }

    public function isEnabled(?string $salesChannelId): bool
    {
        $value = $this->systemConfig->get(self::PREFIX . 'enabled', $salesChannelId);

        return $value === null ? true : (bool) $value;
    }

    public function getShippingCostMode(?string $salesChannelId): string
    {
        $mode = $this->systemConfig->getString(self::PREFIX . 'shippingCostMode', $salesChannelId);

        return $mode === self::MODE_SINGLE ? self::MODE_SINGLE : self::MODE_PER_DESTINATION;
    }

    public function getAdditionalDestinationFee(?string $salesChannelId): float
    {
        return max(0.0, $this->systemConfig->getFloat(self::PREFIX . 'additionalDestinationFee', $salesChannelId));
    }

    public function getMaxDestinations(?string $salesChannelId): int
    {
        $max = $this->systemConfig->getInt(self::PREFIX . 'maxDestinations', $salesChannelId);

        return $max >= 2 ? $max : 10;
    }

    /**
     * @return array{enabled: bool, shippingCostMode: string, additionalDestinationFee: float, maxDestinations: int}
     */
    public function toArray(?string $salesChannelId): array
    {
        return [
            'enabled' => $this->isEnabled($salesChannelId),
            'shippingCostMode' => $this->getShippingCostMode($salesChannelId),
            'additionalDestinationFee' => $this->getAdditionalDestinationFee($salesChannelId),
            'maxDestinations' => $this->getMaxDestinations($salesChannelId),
        ];
    }
}

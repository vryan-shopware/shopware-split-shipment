<?php declare(strict_types=1);

namespace DemoSplitShipment\Checkout\SplitShipment\SalesChannel;

use DemoSplitShipment\Checkout\SplitShipment\SplitShipmentAllocations;
use DemoSplitShipment\Checkout\SplitShipment\SplitShipmentConfig;
use Shopware\Core\Checkout\Cart\SalesChannel\CartResponse;
use Shopware\Core\Checkout\Cart\SalesChannel\CartService;
use Shopware\Core\Checkout\Customer\Aggregate\CustomerAddress\CustomerAddressCollection;
use Shopware\Core\Framework\DataAbstractionLayer\EntityRepository;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Criteria;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Filter\EqualsFilter;
use Shopware\Core\Framework\Struct\ArrayStruct;
use Shopware\Core\System\SalesChannel\SalesChannelContext;
use Shopware\Core\System\SalesChannel\StoreApiResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpKernel\Exception\BadRequestHttpException;
use Symfony\Component\Routing\Attribute\Route;

/**
 * Store API for split shipments.
 *
 *  GET|POST /store-api/split-shipment
 *      Settings and the cart's current assignments.
 *
 *  POST /store-api/split-shipment/allocations
 *      Body: {"allocations": {"<lineItemId>": {"<customerAddressId>": <quantity>, ...}, ...}}
 *      Replaces the assignments (an empty object clears them) and returns the
 *      recalculated cart, with one delivery per destination in cart.deliveries.
 *      Units not assigned ship to the checkout shipping address.
 */
#[Route(defaults: ['_routeScope' => ['store-api']])]
class SplitShipmentRoute
{
    /**
     * @param EntityRepository<CustomerAddressCollection> $addressRepository
     */
    public function __construct(
        private readonly CartService $cartService,
        private readonly SplitShipmentConfig $config,
        private readonly EntityRepository $addressRepository
    ) {
    }

    #[Route(path: '/store-api/split-shipment', name: 'store-api.split-shipment.load', defaults: ['_loginRequired' => true], methods: ['GET', 'POST'])]
    public function load(SalesChannelContext $context): StoreApiResponse
    {
        $cart = $this->cartService->getCart($context->getToken(), $context);
        $allocations = $cart->getExtension(SplitShipmentAllocations::EXTENSION_NAME);

        return new StoreApiResponse(new ArrayStruct([
            'config' => $this->config->toArray($context->getSalesChannelId()),
            'allocations' => $allocations instanceof SplitShipmentAllocations ? $allocations->getAllocations() : [],
        ], 'split_shipment'));
    }

    #[Route(path: '/store-api/split-shipment/allocations', name: 'store-api.split-shipment.save', defaults: ['_loginRequired' => true], methods: ['POST'])]
    public function save(Request $request, SalesChannelContext $context): CartResponse
    {
        if (!$this->config->isEnabled($context->getSalesChannelId())) {
            throw new BadRequestHttpException('Split shipments are turned off for this sales channel.');
        }

        $customer = $context->getCustomer();
        \assert($customer !== null);

        $input = $request->request->all('allocations');
        $cart = $this->cartService->getCart($context->getToken(), $context);

        $addressIds = [];
        foreach ($input as $byAddress) {
            if (\is_array($byAddress)) {
                foreach (array_keys($byAddress) as $addressId) {
                    $addressIds[(string) $addressId] = true;
                }
            }
        }
        $ownAddresses = [];
        if ($addressIds !== []) {
            $criteria = new Criteria(array_keys($addressIds));
            $criteria->addFilter(new EqualsFilter('customerId', $customer->getId()));
            $ownAddresses = array_flip($this->addressRepository->searchIds($criteria, $context->getContext())->getIds());
        }

        $allocations = [];
        $destinations = [];
        foreach ($input as $lineItemId => $byAddress) {
            $lineItem = $cart->getLineItems()->get((string) $lineItemId);
            if ($lineItem === null) {
                throw new BadRequestHttpException(\sprintf('Cart line %s does not exist.', $lineItemId));
            }
            if (!\is_array($byAddress)) {
                throw new BadRequestHttpException('Allocations must map each cart line to {addressId: quantity}.');
            }

            $sum = 0;
            foreach ($byAddress as $addressId => $quantity) {
                $addressId = (string) $addressId;
                if (!isset($ownAddresses[$addressId])) {
                    throw new BadRequestHttpException(\sprintf('Address %s is not one of your saved addresses.', $addressId));
                }
                if (!is_numeric($quantity) || (int) $quantity < 0) {
                    throw new BadRequestHttpException('Quantities must be whole numbers of 0 or more.');
                }
                $quantity = (int) $quantity;
                if ($quantity === 0) {
                    continue;
                }
                $sum += $quantity;
                $allocations[(string) $lineItemId][$addressId] = $quantity;
                $destinations[$addressId] = true;
            }

            if ($sum > $lineItem->getQuantity()) {
                throw new BadRequestHttpException(\sprintf(
                    'You assigned %d units of "%s" but the cart has %d.',
                    $sum,
                    $lineItem->getLabel() ?? $lineItem->getId(),
                    $lineItem->getQuantity()
                ));
            }
        }

        // The checkout shipping address counts as one destination.
        $max = $this->config->getMaxDestinations($context->getSalesChannelId());
        if (\count($destinations) + 1 > $max) {
            throw new BadRequestHttpException(\sprintf('An order can ship to at most %d addresses.', $max));
        }

        if ($allocations === []) {
            $cart->removeExtension(SplitShipmentAllocations::EXTENSION_NAME);
        } else {
            $cart->addExtension(SplitShipmentAllocations::EXTENSION_NAME, new SplitShipmentAllocations($allocations));
        }

        return new CartResponse($this->cartService->recalculate($cart, $context));
    }
}

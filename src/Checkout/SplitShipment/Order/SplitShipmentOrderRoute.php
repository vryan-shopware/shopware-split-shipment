<?php declare(strict_types=1);

namespace DemoSplitShipment\Checkout\SplitShipment\Order;

use Shopware\Core\Framework\Context;
use Shopware\Core\Framework\Uuid\Uuid;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpKernel\Exception\BadRequestHttpException;
use Symfony\Component\Routing\Attribute\Route;

/**
 * Admin API for editing an order's shipments (see SplitShipmentOrderEditor).
 *
 *  GET  /api/_action/split-shipment/order/{orderId}
 *      Line items, shipments (address, shipping charge, units per line) and the
 *      customer's saved addresses.
 *
 *  POST /api/_action/split-shipment/order/{orderId}
 *      Body: the shipment plan. Reprices the order and returns the new state.
 *
 * Both work on the order version in the `sw-version-id` header, like the admin's
 * own order edits. Apps (such as Sales Agent) need order read/update permissions.
 */
#[Route(defaults: ['_routeScope' => ['api']])]
class SplitShipmentOrderRoute
{
    public function __construct(private readonly SplitShipmentOrderEditor $editor)
    {
    }

    #[Route(
        path: '/api/_action/split-shipment/order/{orderId}',
        name: 'api.action.split-shipment.order.load',
        defaults: ['_acl' => ['order:read']],
        methods: ['GET']
    )]
    public function load(string $orderId, Context $context): JsonResponse
    {
        $this->validateId($orderId);

        return new JsonResponse($this->editor->describe($orderId, $context));
    }

    #[Route(
        path: '/api/_action/split-shipment/order/{orderId}',
        name: 'api.action.split-shipment.order.save',
        defaults: ['_acl' => ['order:update']],
        methods: ['POST']
    )]
    public function save(string $orderId, Request $request, Context $context): JsonResponse
    {
        $this->validateId($orderId);

        $plan = $request->toArray();
        $this->editor->apply($orderId, $plan, $context);

        return new JsonResponse($this->editor->describe($orderId, $context));
    }

    private function validateId(string $orderId): void
    {
        if (!Uuid::isValid($orderId)) {
            throw new BadRequestHttpException('Invalid order id.');
        }
    }
}

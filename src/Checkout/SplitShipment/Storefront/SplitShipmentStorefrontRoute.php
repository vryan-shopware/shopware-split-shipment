<?php declare(strict_types=1);

namespace DemoSplitShipment\Checkout\SplitShipment\Storefront;

use DemoSplitShipment\Checkout\SplitShipment\SalesChannel\SplitShipmentRoute;
use Shopware\Core\Checkout\Customer\Aggregate\CustomerAddress\CustomerAddressCollection;
use Shopware\Core\Checkout\Customer\Aggregate\CustomerAddress\CustomerAddressEntity;
use Shopware\Core\Framework\DataAbstractionLayer\EntityRepository;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Criteria;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Filter\EqualsFilter;
use Shopware\Core\Framework\Struct\ArrayStruct;
use Shopware\Core\System\SalesChannel\SalesChannelContext;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpKernel\Exception\BadRequestHttpException;
use Symfony\Component\Routing\Attribute\Route;

/**
 * Storefront (Twig) access to split shipments, for the checkout confirm page.
 *
 * Shopware 6.7 keeps the context token out of Twig, so storefront scripts
 * can't call the Store API routes; these routes use the shopper's session
 * and the same logic as SplitShipmentRoute.
 *
 *  GET  /widgets/split-shipment
 *      Settings, the cart's assignments, the buyer's saved addresses and the
 *      checkout shipping address.
 *
 *  POST /widgets/split-shipment/allocations
 *      Body: {"allocations": {"<lineItemId>": {"<customerAddressId>": <quantity>}}}
 *      Same rules as the Store API route; errors come back as HTTP 400
 *      {"errors": [{"detail": "..."}]}.
 */
#[Route(defaults: ['_routeScope' => ['storefront']])]
class SplitShipmentStorefrontRoute
{
    /**
     * @param EntityRepository<CustomerAddressCollection> $addressRepository
     */
    public function __construct(
        private readonly SplitShipmentRoute $route,
        private readonly EntityRepository $addressRepository
    ) {
    }

    #[Route(path: '/widgets/split-shipment', name: 'frontend.split-shipment.load', defaults: ['XmlHttpRequest' => true, '_loginRequired' => true], methods: ['GET'])]
    public function load(SalesChannelContext $context): JsonResponse
    {
        $customer = $context->getCustomer();
        \assert($customer !== null);

        $data = $this->route->load($context)->getObject();
        $values = $data instanceof ArrayStruct ? $data->all() : [];

        $criteria = new Criteria();
        $criteria->addFilter(new EqualsFilter('customerId', $customer->getId()));
        $addresses = [];
        foreach ($this->addressRepository->search($criteria, $context->getContext())->getEntities() as $address) {
            \assert($address instanceof CustomerAddressEntity);
            $addresses[] = [
                'id' => $address->getId(),
                'company' => $address->getCompany(),
                'firstName' => $address->getFirstName(),
                'lastName' => $address->getLastName(),
                'street' => $address->getStreet(),
                'zipcode' => $address->getZipcode(),
                'city' => $address->getCity(),
            ];
        }

        return new JsonResponse([
            'config' => $values['config'] ?? [],
            'allocations' => $values['allocations'] ?? [],
            'addresses' => $addresses,
            'shippingAddressId' => $customer->getActiveShippingAddress()?->getId(),
        ]);
    }

    #[Route(path: '/widgets/split-shipment/allocations', name: 'frontend.split-shipment.save', defaults: ['XmlHttpRequest' => true, '_loginRequired' => true], methods: ['POST'])]
    public function save(Request $request, SalesChannelContext $context): JsonResponse
    {
        try {
            $this->route->save($request, $context);
        } catch (BadRequestHttpException $exception) {
            return new JsonResponse(['errors' => [['detail' => $exception->getMessage()]]], 400);
        }

        return new JsonResponse(['ok' => true]);
    }
}

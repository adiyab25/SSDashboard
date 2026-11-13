import { Injectable, type OnModuleInit } from '@nestjs/common';
import { TaskLinks } from '../../tasks/task-links.js';
import { OrderQueries } from './order-query.service.js';

/**
 * Gives a task on an order its label and link (spec 0016 AC-12, `TaskLinks`): the order number and
 * store code, and the path of the order page, read through this module's own `summaryOf`.
 * Registered from `onModuleInit`, so the tasks module never imports orders. It never reads a
 * ship to field: a label holds no phone, name, or address.
 */
@Injectable()
export class OrderTaskLink implements OnModuleInit {
  /** Takes the registry of the tasks module and the order reads. */
  constructor(
    private readonly links: TaskLinks,
    private readonly orders: OrderQueries,
  ) {}

  /** Registers the `order` resolver. */
  onModuleInit(): void {
    this.links.register(
      'order',
      {
        describe: async (ids) => {
          const summaries = await this.orders.summaryOf(ids);
          return new Map(
            summaries.map((order) => [
              order.id,
              {
                label: {
                  kind: 'order' as const,
                  number: order.orderNumber,
                  storeCode: order.storeCode,
                },
                path: `/orders/${order.id}`,
              },
            ]),
          );
        },
      },
      'orders',
    );
  }
}

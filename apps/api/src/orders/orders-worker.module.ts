import { Module } from '@nestjs/common';
import { OrdersModule } from './orders.module.js';
import { PostShipmentJob } from './shipment/post-shipment.job.js';

/**
 * The orders module's worker half (spec 0013 task 15): the `orders.post_shipment` queue and its
 * handler (`PostShipmentJob`, declared through the worker's `JobRegistry`), whose work is the
 * orders module's `ShipmentPosting`. Imported only by `WorkerModule`, because the `JobRegistry`
 * exists only in the worker; the api sends these jobs through `ShipmentJobs` and never runs them.
 */
@Module({
  imports: [OrdersModule],
  providers: [PostShipmentJob],
})
export class OrdersWorkerModule {}

import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  AssignOrderInput,
  CancelOrderInput,
  CreateOrderInput,
  OpenDisputeInput,
  OrderListQuery,
  ResolveDisputeInput,
} from '@kolo/contracts';
import { ZodPipe } from '../common/zod.pipe.js';
import { OrdersService } from './orders.service.js';

@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  list(@Query(new ZodPipe(OrderListQuery)) q: OrderListQuery) {
    return this.orders.list(q);
  }

  @Get('disputes')
  disputes(@Query('status') status?: string) {
    return this.orders.disputes(status);
  }

  @Post('disputes/:disputeId/resolve')
  resolve(@Param('disputeId') disputeId: string, @Body(new ZodPipe(ResolveDisputeInput)) input: ResolveDisputeInput) {
    return this.orders.resolveDispute(disputeId, input);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.orders.get(id);
  }

  @Post()
  create(@Body(new ZodPipe(CreateOrderInput)) input: CreateOrderInput) {
    return this.orders.create(input);
  }

  @Post(':id/cancel')
  cancel(@Param('id') id: string, @Body(new ZodPipe(CancelOrderInput)) input: CancelOrderInput) {
    return this.orders.cancel(id, input.reason, input.actor);
  }

  @Post(':id/assign')
  assign(@Param('id') id: string, @Body(new ZodPipe(AssignOrderInput)) input: AssignOrderInput) {
    return this.orders.assign(id, input.vehicleId);
  }

  @Post(':id/disputes')
  openDispute(@Param('id') id: string, @Body(new ZodPipe(OpenDisputeInput)) input: OpenDisputeInput) {
    return this.orders.openDispute(id, input.reason);
  }
}

import { Request, Response } from 'express';
import * as paymentService from '../services/payment.service';
import { created, ok, okList } from '../handlers/response';
import { requireAuth } from '../context/authContext';
import { params, query } from '../middleware/validate';
import { IdParam } from '../schemas/common';
import { PaymentListQuery } from '../schemas/payment';

export const paymentController = {
  async create(req: Request, res: Response) {
    return created(res, await paymentService.createPayment(requireAuth(req), req.body));
  },

  async list(req: Request, res: Response) {
    const result = await paymentService.listPayments(
      requireAuth(req),
      query<PaymentListQuery>(req)
    );
    return okList(res, result.data, result.meta);
  },

  async getById(req: Request, res: Response) {
    return ok(res, await paymentService.getPayment(requireAuth(req), params<IdParam>(req).id));
  },

  async allocate(req: Request, res: Response) {
    return ok(
      res,
      await paymentService.allocatePayment(
        requireAuth(req),
        params<IdParam>(req).id,
        req.body.allocations
      )
    );
  },
};

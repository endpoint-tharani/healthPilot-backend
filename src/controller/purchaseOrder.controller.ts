import { Request, Response } from 'express';
import * as purchaseOrderService from '../services/purchaseOrder.service';
import { getDocumentDetail } from '../services/document.service';
import { created, ok, okList } from '../handlers/response';
import { requireAuth } from '../context/authContext';
import { params, query } from '../middleware/validate';
import { DocumentListQuery, IdParam } from '../schemas/common';

export const purchaseOrderController = {
  async create(req: Request, res: Response) {
    const auth = requireAuth(req);
    const id = await purchaseOrderService.createPurchaseOrder(auth, req.body);
    return created(res, await getDocumentDetail(auth, id));
  },

  async list(req: Request, res: Response) {
    const result = await purchaseOrderService.listPurchaseOrders(
      requireAuth(req),
      query<DocumentListQuery>(req)
    );
    return okList(res, result.data, result.meta);
  },

  async getById(req: Request, res: Response) {
    return ok(res, await getDocumentDetail(requireAuth(req), params<IdParam>(req).id));
  },

  async approve(req: Request, res: Response) {
    return ok(
      res,
      await purchaseOrderService.approvePurchaseOrder(
        requireAuth(req),
        params<IdParam>(req).id,
        req.body.reason
      )
    );
  },

  async cancel(req: Request, res: Response) {
    return ok(
      res,
      await purchaseOrderService.cancelPurchaseOrder(
        requireAuth(req),
        params<IdParam>(req).id,
        req.body.reason
      )
    );
  },
};

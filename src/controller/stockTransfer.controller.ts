import { Request, Response } from 'express';
import * as transferService from '../services/stockTransfer.service';
import { getDocumentDetail } from '../services/document.service';
import { created, ok, okList } from '../handlers/response';
import { requireAuth } from '../context/authContext';
import { params, query } from '../middleware/validate';
import { DocumentListQuery, IdParam } from '../schemas/common';

export const stockTransferController = {
  async create(req: Request, res: Response) {
    return created(res, await transferService.createStockTransfer(requireAuth(req), req.body));
  },

  async list(req: Request, res: Response) {
    const result = await transferService.listStockTransfers(
      requireAuth(req),
      query<DocumentListQuery>(req)
    );
    return okList(res, result.data, result.meta);
  },

  async getById(req: Request, res: Response) {
    return ok(res, await getDocumentDetail(requireAuth(req), params<IdParam>(req).id));
  },

  async dispatch(req: Request, res: Response) {
    return ok(
      res,
      await transferService.dispatchStockTransfer(
        requireAuth(req),
        params<IdParam>(req).id,
        req.body.reason
      )
    );
  },

  async receive(req: Request, res: Response) {
    return ok(
      res,
      await transferService.receiveStockTransfer(
        requireAuth(req),
        params<IdParam>(req).id,
        req.body.reason
      )
    );
  },
};

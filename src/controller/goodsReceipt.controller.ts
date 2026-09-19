import { Request, Response } from 'express';
import * as goodsReceiptService from '../services/goodsReceipt.service';
import { getDocumentDetail } from '../services/document.service';
import { created, ok, okList } from '../handlers/response';
import { requireAuth } from '../context/authContext';
import { params, query } from '../middleware/validate';
import { DocumentListQuery, IdParam } from '../schemas/common';

export const goodsReceiptController = {
  async create(req: Request, res: Response) {
    const auth = requireAuth(req);
    const id = await goodsReceiptService.createGoodsReceipt(auth, req.body);
    return created(res, await getDocumentDetail(auth, id));
  },

  async list(req: Request, res: Response) {
    const result = await goodsReceiptService.listGoodsReceipts(
      requireAuth(req),
      query<DocumentListQuery>(req)
    );
    return okList(res, result.data, result.meta);
  },

  async getById(req: Request, res: Response) {
    return ok(res, await getDocumentDetail(requireAuth(req), params<IdParam>(req).id));
  },

  async post(req: Request, res: Response) {
    return ok(
      res,
      await goodsReceiptService.postGoodsReceipt(
        requireAuth(req),
        params<IdParam>(req).id,
        req.body.reason
      )
    );
  },
};

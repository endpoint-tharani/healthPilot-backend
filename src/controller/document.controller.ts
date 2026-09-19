import { Request, Response } from 'express';
import {
  getDocumentDetail,
  getDocumentHistory,
  listDocumentRegister,
} from '../services/document.service';
import { ok, okList } from '../handlers/response';
import { requireAuth } from '../context/authContext';
import { params, query } from '../middleware/validate';
import { IdParam } from '../schemas/common';
import { DocumentRegisterQuery } from '../schemas/document';

export const documentController = {
  async list(req: Request, res: Response) {
    const result = await listDocumentRegister(
      requireAuth(req),
      query<DocumentRegisterQuery>(req)
    );
    return okList(res, result.data, result.meta);
  },

  async getById(req: Request, res: Response) {
    return ok(res, await getDocumentDetail(requireAuth(req), params<IdParam>(req).id));
  },

  async history(req: Request, res: Response) {
    return ok(res, await getDocumentHistory(requireAuth(req), params<IdParam>(req).id));
  },
};

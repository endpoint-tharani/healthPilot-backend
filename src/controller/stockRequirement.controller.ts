import { Request, Response } from 'express';
import * as requirementService from '../services/stockRequirement.service';
import {
  getRequirementInternalAvailability,
  serializeAvailability,
} from '../services/internalAvailability.service';
import {
  getRequirementSourcingAnalysis,
  serializeSourcingAnalysis,
} from '../services/requirementSourcing.service';
import { getDocumentDetail } from '../services/document.service';
import { created, ok, okList } from '../handlers/response';
import { requireAuth } from '../context/authContext';
import { params, query } from '../middleware/validate';
import { DocumentListQuery, IdParam } from '../schemas/common';

export const stockRequirementController = {
  async create(req: Request, res: Response) {
    const auth = requireAuth(req);
    const id = await requirementService.createRequirement(auth, req.body);
    return created(res, await getDocumentDetail(auth, id));
  },

  async list(req: Request, res: Response) {
    const result = await requirementService.listRequirements(
      requireAuth(req),
      query<DocumentListQuery>(req)
    );
    return okList(res, result.data, result.meta);
  },

  async getById(req: Request, res: Response) {
    return ok(res, await getDocumentDetail(requireAuth(req), params<IdParam>(req).id));
  },

  /**
   * What this requirement could be sourced from inside the company. Read-only:
   * it reserves nothing and moves no stock.
   */
  async internalAvailability(req: Request, res: Response) {
    const auth = requireAuth(req);
    const result = await getRequirementInternalAvailability(auth, params<IdParam>(req).id);
    return ok(res, serializeAvailability(result));
  },

  /**
   * The full sourcing picture: internal stock grouped by branch, plus supplier
   * options for whatever it cannot cover. Read-only, like the availability view
   * it builds on.
   */
  async sourcingAnalysis(req: Request, res: Response) {
    const auth = requireAuth(req);
    const result = await getRequirementSourcingAnalysis(auth, params<IdParam>(req).id);
    return ok(res, serializeSourcingAnalysis(result));
  },

  async submit(req: Request, res: Response) {
    return ok(
      res,
      await requirementService.submitRequirement(
        requireAuth(req),
        params<IdParam>(req).id,
        req.body.reason
      )
    );
  },

  async approve(req: Request, res: Response) {
    return ok(
      res,
      await requirementService.approveRequirement(
        requireAuth(req),
        params<IdParam>(req).id,
        req.body.reason
      )
    );
  },

  async reject(req: Request, res: Response) {
    return ok(
      res,
      await requirementService.rejectRequirement(
        requireAuth(req),
        params<IdParam>(req).id,
        req.body.reason
      )
    );
  },
};

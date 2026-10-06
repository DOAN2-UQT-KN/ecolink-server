import { Request, Response } from "express";
import { body, param, query, validationResult, type ValidationChain } from "express-validator";
import {
  SOS_RESOLUTION_CODE,
  SOS_STATE,
  SOS_LIVE_STATES,
  SOS_TYPES,
  type SosResolutionCodeValue,
  type SosStateValue,
  type SosTypeValue,
} from "@da2/constants";
import {
  HTTP_STATUS,
  HttpError,
  sendError,
  sendHttpErrorResponse,
  sendSuccess,
} from "../../constants/http-status";
import { parseSchedule, sosAvailabilityService } from "./sos-availability.service";
import { resolveSosEligibility } from "./sos-eligibility";
import { sosService } from "./sos.service";
import type { CreateSosRequest, SosActor } from "./sos.dto";

const STATES = Object.values(SOS_STATE) as string[];
const CODES = Object.values(SOS_RESOLUTION_CODE) as string[];

/** Query params arrive as sent (snake_case); camelCase is still accepted for older clients. */
const q = (req: Request, snake: string, camel: string): string | undefined => {
  const v = req.query[snake] ?? req.query[camel];
  return typeof v === "string" && v.length > 0 ? v : undefined;
};
const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));

const latLngQuery = (required: boolean): ValidationChain[] =>
  (["latitude", "longitude"] as const).map((k) => {
    const chain = query(k);
    return (required ? chain.exists() : chain.optional())
      .isFloat(k === "latitude" ? { min: -90, max: 90 } : { min: -180, max: 180 })
      .withMessage(`${k} is out of range`);
  });

const latLngBody: ValidationChain[] = [
  body("latitude").isFloat({ min: -90, max: 90 }).withMessage("latitude must be between -90 and 90"),
  body("longitude").isFloat({ min: -180, max: 180 }).withMessage("longitude must be between -180 and 180"),
];

const sosIdParam = param("id").isInt({ min: 1 }).withMessage("id must be a positive integer");

export class SosController {
  /** Validation, the signed-in actor, the error envelope; `run` returns the response data. */
  private action(
    label: string,
    chains: ValidationChain[],
    run: (req: Request, actor: SosActor) => Promise<unknown>,
    created = false,
  ) {
    return [
      ...chains,
      async (req: Request, res: Response): Promise<void> => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          return sendError(res, HTTP_STATUS.VALIDATION_ERROR, { errors: errors.array() });
        }
        const userId = req.user?.userId;
        if (!userId) return sendError(res, HTTP_STATUS.UNAUTHORIZED);
        try {
          const data = await run(req, { userId, role: req.user?.role });
          sendSuccess(res, created ? HTTP_STATUS.CREATED : HTTP_STATUS.OK, data);
        } catch (error) {
          if (sendHttpErrorResponse(res, error)) return;
          console.error(`${label} error:`, error);
          sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      },
    ];
  }

  /** GET /api/v1/sos/eligibility?campaign_id=&latitude=&longitude= */
  eligibility = this.action(
    "SOS eligibility",
    [
      query(["campaign_id", "campaignId"]).optional().isUUID().withMessage("campaign_id must be a valid UUID"),
      ...latLngQuery(false),
    ],
    async (req, actor) => {
      const campaignId = q(req, "campaign_id", "campaignId");
      if (!campaignId) {
        throw new HttpError(HTTP_STATUS.VALIDATION_ERROR.withMessage("campaign_id is required"));
      }
      const { running: _running, phone: _phone, ...view } = await resolveSosEligibility(
        campaignId,
        actor.userId,
        { latitude: num(q(req, "latitude", "lat")), longitude: num(q(req, "longitude", "lng")) },
      );
      return view;
    },
  );

  /** POST /api/v1/sos */
  createSos = this.action(
    "Create SOS",
    [
      body("campaignId").isUUID().withMessage("campaign_id must be a valid UUID"),
      body("shiftId").optional({ values: "null" }).isUUID().withMessage("shift_id must be a valid UUID"),
      body("type").isIn(SOS_TYPES).withMessage(`type must be one of ${SOS_TYPES.join(", ")}`),
      body("details").isObject().withMessage("details is required"),
      body("description").optional({ values: "null" }).isString().trim().isLength({ max: 2000 }),
      body("photoUrls").optional({ values: "null" }).isArray({ max: 5 }).withMessage("at most 5 photos"),
      body("photoUrls.*").isURL().withMessage("photo_urls must be URLs"),
      body("latitude").optional({ values: "null" }).isFloat({ min: -90, max: 90 }),
      body("longitude").optional({ values: "null" }).isFloat({ min: -180, max: 180 }),
      body("accuracy").optional({ values: "null" }).isFloat({ min: 0 }),
    ],
    (req, actor) => {
      const b = req.body as Record<string, unknown>;
      const input: CreateSosRequest = {
        campaignId: String(b.campaignId),
        shiftId: (b.shiftId as string | undefined) ?? undefined,
        type: b.type as SosTypeValue,
        details: b.details as Record<string, unknown>,
        description: (b.description as string | undefined) ?? undefined,
        photoUrls: (b.photoUrls as string[] | undefined) ?? [],
        latitude: b.latitude != null ? Number(b.latitude) : undefined,
        longitude: b.longitude != null ? Number(b.longitude) : undefined,
        accuracy: b.accuracy != null ? Number(b.accuracy) : undefined,
      };
      return sosService.create(input, actor);
    },
    true,
  );

  /** GET /api/v1/sos/duplicates?campaign_id=&type=&latitude=&longitude= */
  duplicates = this.action(
    "SOS duplicates",
    [
      query(["campaign_id", "campaignId"]).optional().isUUID(),
      query("type").isIn(SOS_TYPES).withMessage(`type must be one of ${SOS_TYPES.join(", ")}`),
      ...latLngQuery(true),
    ],
    async (req, actor) => {
      const campaignId = q(req, "campaign_id", "campaignId");
      if (!campaignId) return [];
      return sosService.duplicates(
        {
          campaignId,
          type: req.query.type as SosTypeValue,
          latitude: Number(req.query.latitude),
          longitude: Number(req.query.longitude),
        },
        actor,
      );
    },
  );

  /** GET /api/v1/sos — live SOS by default, medical first. */
  listSos = this.action(
    "List SOS",
    [
      query(["campaign_id", "campaignId"]).optional().isUUID().withMessage("campaign_id must be a valid UUID"),
      query("states").optional().isString(),
      ...latLngQuery(false),
      query(["max_distance", "maxDistance"]).optional().isInt({ min: 1 }),
      query("page").optional().isInt({ min: 1 }),
      query("limit").optional().isInt({ min: 1, max: 100 }),
    ],
    async (req, actor) => {
      const states = (q(req, "states", "states") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => STATES.includes(s)) as SosStateValue[];
      return sosService.list(
        {
          campaignId: q(req, "campaign_id", "campaignId"),
          states: states.length > 0 ? states : SOS_LIVE_STATES,
          latitude: num(q(req, "latitude", "latitude")),
          longitude: num(q(req, "longitude", "longitude")),
          maxDistance: num(q(req, "max_distance", "maxDistance")),
          page: Number(req.query.page ?? 1),
          limit: Number(req.query.limit ?? 20),
        },
        actor,
      );
    },
  );

  /** GET /api/v1/sos/:id */
  getSos = this.action("Get SOS", [sosIdParam], (req, actor) =>
    sosService.getDetail(Number(req.params.id), actor),
  );

  /** POST /api/v1/sos/:id/respond — "Tôi tới giúp ngay". */
  respond = this.action("Respond to SOS", [sosIdParam], (req, actor) =>
    sosService.respond(Number(req.params.id), actor),
  );

  /** DELETE /api/v1/sos/:id/respond — "Không tới được nữa". */
  cancelResponse = this.action("Cancel SOS response", [sosIdParam], (req, actor) =>
    sosService.cancelResponse(Number(req.params.id), actor),
  );

  /** PUT /api/v1/sos/:id/respond/location — the responder's position. */
  responderLocation = this.action("SOS responder location", [sosIdParam, ...latLngBody], (req, actor) =>
    sosService.updateResponderLocation(Number(req.params.id), actor, {
      latitude: Number(req.body.latitude),
      longitude: Number(req.body.longitude),
    }),
  );

  /** PUT /api/v1/sos/:id/location — the reporter moves the SOS. */
  updateLocation = this.action("Update SOS location", [sosIdParam, ...latLngBody], (req, actor) =>
    sosService.updateLocation(Number(req.params.id), actor, {
      latitude: Number(req.body.latitude),
      longitude: Number(req.body.longitude),
    }),
  );

  /** PUT /api/v1/sos/:id/resolve */
  resolveSos = this.action(
    "Resolve SOS",
    [
      sosIdParam,
      body("code").isIn(CODES).withMessage(`code must be one of ${CODES.join(", ")}`),
      body("note").optional({ values: "null" }).isString().trim().isLength({ max: 1000 }),
    ],
    (req, actor) =>
      sosService.resolve(Number(req.params.id), actor, {
        code: req.body.code as SosResolutionCodeValue,
        note: (req.body.note as string | undefined) ?? null,
      }),
  );

  /** PUT /api/v1/sos/:id/solved — legacy alias of resolve (handled). */
  solveSos = this.action("Solve SOS", [sosIdParam], (req, actor) =>
    sosService.solveSos(Number(req.params.id), actor),
  );

  /** GET /api/v1/sos/me/availability */
  getAvailability = this.action("Get SOS availability", [], (_req, actor) =>
    sosAvailabilityService.get(actor.userId),
  );

  /** PUT /api/v1/sos/me/availability { enabled, schedule } */
  updateAvailability = this.action(
    "Update SOS availability",
    [
      body("enabled").isBoolean().withMessage("enabled must be a boolean"),
      body("schedule")
        .optional({ values: "null" })
        .custom((v) => parseSchedule(v) !== null)
        .withMessage('schedule must be [{ days: [0..6], from: "HH:mm", to: "HH:mm" }] with from before to'),
    ],
    (req, actor) =>
      sosAvailabilityService.update(actor.userId, {
        enabled: req.body.enabled === true || req.body.enabled === "true",
        schedule: parseSchedule(req.body.schedule ?? []) ?? [],
      }),
  );

  /** PUT /api/v1/sos/me/availability/location { latitude, longitude } */
  updateAvailabilityLocation = this.action("Update SOS availability location", latLngBody, (req, actor) =>
    sosAvailabilityService.updateLocation(actor.userId, {
      latitude: Number(req.body.latitude),
      longitude: Number(req.body.longitude),
    }),
  );
}

export const sosController = new SosController();

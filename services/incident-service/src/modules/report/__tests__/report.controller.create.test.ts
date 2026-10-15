const createReportMock = jest.fn();

jest.mock("../report.service", () => ({
  reportService: { createReport: (...args: unknown[]) => createReportMock(...args) },
}));

import { HttpError, HTTP_STATUS } from "../../../constants/http-status";
import { reportController } from "../report.controller";

const KEY = "8f1d7f4e-2a51-4c4b-9a0e-0d5f3b8e6c11";
const body = {
  title: "t",
  latitude: 10.79,
  longitude: 106.68,
  images: [{ url: "https://res.cloudinary.com/ecolink/image/upload/a.jpg" }],
};

function fakeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
    set(name: string, value: string) {
      res.headers[name] = value;
      return res;
    },
  };
  return res;
}

async function call(headers: Record<string, string> = {}) {
  const req = {
    body,
    headers,
    user: { userId: "user-1" },
    get: (name: string) => headers[name],
  };
  const res = fakeRes();
  for (const step of reportController.createReport) {
    // Validators are express middlewares with (req, res, next); the handler takes (req, res).
    await (step as (req: unknown, res: unknown, next: () => void) => unknown)(req, res, () => undefined);
  }
  return res;
}

describe("POST /reports controller", () => {
  const previous = process.env.CLOUDINARY_CLOUD_NAME;
  beforeAll(() => {
    process.env.CLOUDINARY_CLOUD_NAME = "ecolink";
  });
  afterAll(() => {
    process.env.CLOUDINARY_CLOUD_NAME = previous;
  });
  beforeEach(() => createReportMock.mockReset());

  it("returns 202 ACCEPTED and forwards the Idempotency-Key", async () => {
    createReportMock.mockResolvedValue({ report: { id: "r1" }, replayed: false });
    const res = await call({ "Idempotency-Key": KEY });
    expect(res.statusCode).toBe(202);
    expect(res.body).toMatchObject({ success: true, code: "ACCEPTED", data: { report: { id: "r1" } } });
    expect(createReportMock).toHaveBeenCalledWith("user-1", body, undefined, KEY);
  });

  it("maps REPORT_RATE_LIMITED to 429 with Retry-After", async () => {
    const retryAfter = new Date(Date.now() + 3600_000).toISOString();
    createReportMock.mockRejectedValue(new HttpError(HTTP_STATUS.REPORT_RATE_LIMITED, { retryAfter }));
    const res = await call();
    expect(res.statusCode).toBe(429);
    expect(res.body).toMatchObject({ code: "REPORT_RATE_LIMITED", retryAfter });
    expect(Number(res.headers["Retry-After"])).toBeGreaterThanOrEqual(3599);
    expect(Number(res.headers["Retry-After"])).toBeLessThanOrEqual(3600);
  });

  it("maps REPORT_OUT_OF_SERVICE_AREA to 422", async () => {
    createReportMock.mockRejectedValue(new HttpError(HTTP_STATUS.REPORT_OUT_OF_SERVICE_AREA));
    const res = await call();
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatchObject({ code: "REPORT_OUT_OF_SERVICE_AREA" });
  });

  it("rejects a non-UUID Idempotency-Key without calling the service", async () => {
    const res = await call({ "Idempotency-Key": "abc" });
    expect(res.statusCode).toBe(400);
    expect(createReportMock).not.toHaveBeenCalled();
  });

  it("returns 500 on unexpected errors", async () => {
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    createReportMock.mockRejectedValue(new Error("boom"));
    const res = await call();
    expect(res.statusCode).toBe(500);
  });
});

import { Request, Response } from "express";
import { HTTP_STATUS } from "../../constants/http-status";
import { requireInternalAiApiKey } from "../internal-ai-auth.middleware";

function mockRes() {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res as unknown as Response & {
    status: jest.Mock;
    json: jest.Mock;
  };
}

describe("requireInternalAiApiKey", () => {
  const original = process.env.INTERNAL_AI_API_KEY;

  afterEach(() => {
    process.env.INTERNAL_AI_API_KEY = original;
  });

  it("returns 500 when INTERNAL_AI_API_KEY is not configured", () => {
    delete process.env.INTERNAL_AI_API_KEY;
    const res = mockRes();
    const next = jest.fn();
    requireInternalAiApiKey({ header: () => undefined } as unknown as Request, res, next);
    expect(res.status).toHaveBeenCalledWith(
      HTTP_STATUS.INTERNAL_SERVER_ERROR.status,
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when the key does not match", () => {
    process.env.INTERNAL_AI_API_KEY = "secret";
    const res = mockRes();
    const next = jest.fn();
    requireInternalAiApiKey(
      { header: () => "wrong" } as unknown as Request,
      res,
      next,
    );
    expect(res.status).toHaveBeenCalledWith(HTTP_STATUS.UNAUTHORIZED.status);
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next when the key matches", () => {
    process.env.INTERNAL_AI_API_KEY = "secret";
    const res = mockRes();
    const next = jest.fn();
    requireInternalAiApiKey(
      { header: () => "secret" } as unknown as Request,
      res,
      next,
    );
    expect(next).toHaveBeenCalled();
  });
});

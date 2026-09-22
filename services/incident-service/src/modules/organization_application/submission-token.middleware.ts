import { NextFunction, Request, Response } from "express";
import {
  HTTP_STATUS,
  sendError,
  sendHttpErrorResponse,
} from "../../constants/http-status";
import { organizationApplicationOtpService } from "./organization-application-otp.service";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Mailbox the caller proved ownership of via the email OTP. */
      submissionEmail?: string;
      /** Raw token, so the submit handler can burn it once the row is written. */
      submissionToken?: string;
    }
  }
}

/**
 * Authenticates the anonymous application form. There is no login here — the only thing the
 * caller has proved is that they can read mail at one address, so that address is what the
 * rest of the request is scoped to (`req.submissionEmail`). Handlers must never take the
 * contact email from the body.
 */
export const requireSubmissionToken = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const token = req.header("x-submission-token")?.trim();
  if (!token) {
    sendError(res, HTTP_STATUS.SUBMISSION_TOKEN_INVALID);
    return;
  }

  try {
    req.submissionEmail =
      await organizationApplicationOtpService.resolveSubmissionToken(token);
    req.submissionToken = token;
    next();
  } catch (error) {
    if (sendHttpErrorResponse(res, error)) {
      return;
    }
    console.error("[organization-application] submission token check:", error);
    sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

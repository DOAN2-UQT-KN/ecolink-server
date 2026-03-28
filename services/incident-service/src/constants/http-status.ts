/**
 * HTTP Status Response Type
 */
export interface HttpStatusResponse {
  status: number;
  message: string;
  code: string;
  withMessage: (customMessage: string) => HttpStatusResponse;
}

/**
 * Helper to create status response with withMessage method
 */
const createStatus = (
  status: number,
  message: string,
  code: string,
): HttpStatusResponse => ({
  status,
  message,
  code,
  withMessage: (customMessage: string) =>
    createStatus(status, customMessage, code),
});

/**
 * Centralized HTTP status responses for consistent API responses
 */
export const HTTP_STATUS = {
  OK: createStatus(200, "Request successful", "OK"),
  CREATED: createStatus(201, "Resource created successfully", "CREATED"),
  ACCEPTED: createStatus(202, "Request accepted", "ACCEPTED"),
  NO_CONTENT: createStatus(204, "No content", "NO_CONTENT"),

  BAD_REQUEST: createStatus(400, "Bad request", "BAD_REQUEST"),
  UNAUTHORIZED: createStatus(401, "Unauthorized", "UNAUTHORIZED"),
  FORBIDDEN: createStatus(403, "Forbidden", "FORBIDDEN"),
  NOT_FOUND: createStatus(404, "Resource not found", "NOT_FOUND"),
  METHOD_NOT_ALLOWED: createStatus(
    405,
    "Method not allowed",
    "METHOD_NOT_ALLOWED",
  ),
  CONFLICT: createStatus(409, "Resource conflict", "CONFLICT"),
  UNPROCESSABLE_ENTITY: createStatus(
    422,
    "Unprocessable entity",
    "UNPROCESSABLE_ENTITY",
  ),
  TOO_MANY_REQUESTS: createStatus(
    429,
    "Too many requests",
    "TOO_MANY_REQUESTS",
  ),

  INTERNAL_SERVER_ERROR: createStatus(
    500,
    "Internal server error",
    "INTERNAL_SERVER_ERROR",
  ),
  NOT_IMPLEMENTED: createStatus(501, "Not implemented", "NOT_IMPLEMENTED"),
  BAD_GATEWAY: createStatus(502, "Bad gateway", "BAD_GATEWAY"),
  SERVICE_UNAVAILABLE: createStatus(
    503,
    "Service unavailable",
    "SERVICE_UNAVAILABLE",
  ),
  GATEWAY_TIMEOUT: createStatus(504, "Gateway timeout", "GATEWAY_TIMEOUT"),

  // Auth-related
  TOKEN_EXPIRED: createStatus(401, "Token has expired", "TOKEN_EXPIRED"),
  TOKEN_INVALID: createStatus(401, "Invalid token", "TOKEN_INVALID"),
  TOKEN_MISSING: createStatus(
    401,
    "Authentication token is required",
    "TOKEN_MISSING",
  ),

  // Report-specific
  REPORT_NOT_FOUND: createStatus(404, "Report not found", "REPORT_NOT_FOUND"),
  REPORT_ALREADY_EXISTS: createStatus(
    409,
    "Report already exists",
    "REPORT_ALREADY_EXISTS",
  ),

  // Task-specific
  TASK_NOT_FOUND: createStatus(404, "Task not found", "TASK_NOT_FOUND"),
  TASK_ALREADY_ASSIGNED: createStatus(
    409,
    "Task already assigned",
    "TASK_ALREADY_ASSIGNED",
  ),

  // Volunteer-specific
  JOIN_REQUEST_NOT_FOUND: createStatus(
    404,
    "Join request not found",
    "JOIN_REQUEST_NOT_FOUND",
  ),
  JOIN_REQUEST_ALREADY_EXISTS: createStatus(
    409,
    "Join request already exists",
    "JOIN_REQUEST_ALREADY_EXISTS",
  ),
  JOIN_REQUEST_ALREADY_PROCESSED: createStatus(
    409,
    "Join request already processed",
    "JOIN_REQUEST_ALREADY_PROCESSED",
  ),

  // Manager-specific
  MANAGER_ALREADY_ASSIGNED: createStatus(
    409,
    "Manager already assigned",
    "MANAGER_ALREADY_ASSIGNED",
  ),
  NOT_A_MANAGER: createStatus(
    403,
    "User is not a manager for this report",
    "NOT_A_MANAGER",
  ),
  NOT_A_REPORTER: createStatus(
    403,
    "User is not the reporter",
    "NOT_A_REPORTER",
  ),

  // Result-specific
  RESULT_NOT_FOUND: createStatus(404, "Result not found", "RESULT_NOT_FOUND"),
  RESULT_ALREADY_APPROVED: createStatus(
    409,
    "Result already approved",
    "RESULT_ALREADY_APPROVED",
  ),

  // Validation
  VALIDATION_ERROR: createStatus(400, "Validation failed", "VALIDATION_ERROR"),
  MISSING_REQUIRED_FIELD: createStatus(
    400,
    "Missing required field",
    "MISSING_REQUIRED_FIELD",
  ),
  INVALID_INPUT: createStatus(400, "Invalid input provided", "INVALID_INPUT"),

  // Database
  DATABASE_ERROR: createStatus(
    500,
    "Database error occurred",
    "DATABASE_ERROR",
  ),
  DUPLICATE_ENTRY: createStatus(409, "Duplicate entry", "DUPLICATE_ENTRY"),
} as const;

/**
 * Domain error carrying the exact {@link HttpStatusResponse} to send to the client.
 * Throw this from services instead of generic `Error` + message parsing in controllers.
 */
export class HttpError extends Error {
  readonly statusResponse: HttpStatusResponse;

  constructor(statusResponse: HttpStatusResponse) {
    super(statusResponse.message);
    this.name = "HttpError";
    this.statusResponse = statusResponse;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  static isHttpError(error: unknown): error is HttpError {
    return error instanceof HttpError;
  }
}

/**
 * If `error` is an {@link HttpError}, sends the response and returns true.
 */
export const sendHttpErrorResponse = (res: any, error: unknown): boolean => {
  if (HttpError.isHttpError(error)) {
    sendError(res, error.statusResponse);
    return true;
  }
  return false;
};

export const sendError = (
  res: any,
  statusResponse: HttpStatusResponse,
  additionalData?: Record<string, any>,
): void => {
  res.status(statusResponse.status).json({
    success: false,
    code: statusResponse.code,
    message: statusResponse.message,
    ...additionalData,
  });
};

export const sendSuccess = (
  res: any,
  statusResponse: HttpStatusResponse = HTTP_STATUS.OK,
  data?: any,
): void => {
  res.status(statusResponse.status).json({
    success: true,
    code: statusResponse.code,
    message: statusResponse.message,
    ...(data && { data }),
  });
};

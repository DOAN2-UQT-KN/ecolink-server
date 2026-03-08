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
 * Usage:
 * - HTTP_STATUS.USER_NOT_FOUND.status, .message, .code
 * - HTTP_STATUS.INTERNAL_SERVER_ERROR.withMessage("Login failed")
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

  INVALID_CREDENTIALS: createStatus(
    401,
    "Invalid email or password",
    "INVALID_CREDENTIALS",
  ),
  TOKEN_EXPIRED: createStatus(401, "Token has expired", "TOKEN_EXPIRED"),
  TOKEN_INVALID: createStatus(401, "Invalid token", "TOKEN_INVALID"),
  TOKEN_MISSING: createStatus(
    401,
    "Authentication token is required",
    "TOKEN_MISSING",
  ),

  USER_NOT_FOUND: createStatus(404, "User not found", "USER_NOT_FOUND"),
  USER_ALREADY_EXISTS: createStatus(
    409,
    "User already exists",
    "USER_ALREADY_EXISTS",
  ),
  USER_INACTIVE: createStatus(403, "User account is inactive", "USER_INACTIVE"),

  VALIDATION_ERROR: createStatus(400, "Validation failed", "VALIDATION_ERROR"),
  MISSING_REQUIRED_FIELD: createStatus(
    400,
    "Missing required field",
    "MISSING_REQUIRED_FIELD",
  ),
  INVALID_INPUT: createStatus(400, "Invalid input provided", "INVALID_INPUT"),

  DATABASE_ERROR: createStatus(
    500,
    "Database error occurred",
    "DATABASE_ERROR",
  ),
  DUPLICATE_ENTRY: createStatus(409, "Duplicate entry", "DUPLICATE_ENTRY"),
} as const;

export const createHttpStatus = (
  status: number,
  message: string,
  code?: string,
  withMessage?: (customMessage: string) => HttpStatusResponse,
): HttpStatusResponse => {
  return {
    status,
    message,
    code: code || `CUSTOM_${status}`,
    withMessage:
      withMessage ||
      ((customMessage: string) =>
        createHttpStatus(status, customMessage, code)),
  };
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

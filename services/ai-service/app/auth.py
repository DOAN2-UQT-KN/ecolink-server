from typing import Annotated, NamedTuple, Optional

import jwt
from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.config import settings

security = HTTPBearer(auto_error=False)


class AuthContext(NamedTuple):
    user_id: str
    access_token: str


def extract_access_token(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials],
) -> Optional[str]:
    if credentials and credentials.scheme.lower() == "bearer":
        return credentials.credentials
    return request.cookies.get("accessToken")


def _decode_user_id(token: str) -> str:
    if not settings.jwt_secret:
        raise HTTPException(
            status_code=500, detail="AI service JWT_SECRET is not configured"
        )
    try:
        payload = jwt.decode(
            token,
            settings.jwt_secret,
            algorithms=["HS256"],
        )
    except jwt.PyJWTError as e:
        raise HTTPException(status_code=401, detail="Invalid or expired token") from e

    user_id = payload.get("userId") or payload.get("user_id")
    if not user_id or not isinstance(user_id, str):
        raise HTTPException(status_code=401, detail="Token missing user id")
    return user_id


async def get_auth_context(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
) -> AuthContext:
    token = extract_access_token(request, credentials)
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user_id = _decode_user_id(token)
    return AuthContext(user_id=user_id, access_token=token)


async def get_current_user_id(
    auth: Annotated[AuthContext, Depends(get_auth_context)],
) -> str:
    return auth.user_id

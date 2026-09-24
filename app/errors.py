"""RFC 9457 application/problem+json errors.

Every error carries a stable machine-readable `code` (BAD_USER_INPUT, NOT_FOUND, CONFLICT,
INTERNAL_SERVER_ERROR) alongside the HTTP status. The metrics middleware reads the code from the
ASGI scope (`scope["error_code"]`) to increment http_errors_total.
"""

from collections.abc import MutableMapping
from http import HTTPStatus
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

PROBLEM_JSON = "application/problem+json"
VALIDATION_DETAIL = "The request content was invalid or failed validation constraints."

InvalidParam = dict[str, str]


class ApiError(Exception):
    status = 500
    code = "INTERNAL_SERVER_ERROR"

    def __init__(self, detail: str, invalid_params: list[InvalidParam] | None = None) -> None:
        super().__init__(detail)
        self.detail = detail
        self.invalid_params = invalid_params


class BadUserInputError(ApiError):
    status = 400
    code = "BAD_USER_INPUT"


class NotFoundError(ApiError):
    status = 404
    code = "NOT_FOUND"


class ConflictError(ApiError):
    status = 409
    code = "CONFLICT"


class PayloadTooLargeError(ApiError):
    status = 413
    code = "BAD_USER_INPUT"


def problem_response(
    request_scope: MutableMapping[str, Any],
    status: int,
    code: str,
    detail: str,
    invalid_params: list[InvalidParam] | None = None,
) -> JSONResponse:
    request_scope["error_code"] = code
    body: dict[str, Any] = {
        "type": "about:blank",
        "title": HTTPStatus(status).phrase,
        "status": status,
        "detail": detail,
        "code": code,
    }
    if invalid_params:
        body["invalidParams"] = invalid_params
    return JSONResponse(body, status_code=status, media_type=PROBLEM_JSON)


def _param_name(loc: tuple[Any, ...]) -> str:
    # loc is ("body", "title"), ("query", "limit") or ("path", "id"): the field is the tail. A
    # malformed body reports ("body", <char offset>): an int, not a field name.
    parts = [p for p in loc if isinstance(p, str) and p not in ("body", "query", "path")]
    return ".".join(parts) or "body"


def _reason(name: str, error: dict[str, Any]) -> str:
    kind = error["type"]
    ctx = error.get("ctx") or {}
    if kind == "missing" or (kind == "string_type" and error.get("input") is None):
        return f"{name} is required and cannot be blank"
    if kind == "greater_than_equal":
        return (
            f"{name} must not be negative"
            if ctx.get("ge") == 0
            else f"{name} must be at least {ctx.get('ge')}"
        )
    if kind == "less_than_equal":
        return f"{name} must not exceed {ctx.get('le')}"
    if kind == "int_parsing":
        return f"{name} must be an integer"
    if kind == "uuid_parsing":
        return f"{name} must be a valid UUID"
    if kind == "string_type":
        return f"{name} must be a string"
    if kind == "literal_error":
        return f"{name} must be one of: {ctx.get('expected')}"
    if kind in ("json_invalid", "model_attributes_type", "dict_type"):
        return "request body must be a valid JSON object"
    if kind == "value_error":
        # Our own validators raise ValueError("<field> ..."); drop pydantic's prefix.
        return str(error["msg"]).removeprefix("Value error, ")
    return str(error["msg"])


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(request: Request, exc: ApiError) -> JSONResponse:
        return problem_response(request.scope, exc.status, exc.code, exc.detail, exc.invalid_params)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        # FastAPI defaults to 422; this API answers 400 and lists every failing field at once.
        params: list[InvalidParam] = []
        for error in exc.errors():
            name = _param_name(tuple(error["loc"]))
            params.append({"name": name, "reason": _reason(name, dict(error))})
        return problem_response(request.scope, 400, "BAD_USER_INPUT", VALIDATION_DETAIL, params)

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = {404: "NOT_FOUND"}.get(exc.status_code, f"HTTP_{exc.status_code}")
        response = problem_response(request.scope, exc.status_code, code, str(exc.detail))
        if exc.headers:
            response.headers.update(exc.headers)
        return response

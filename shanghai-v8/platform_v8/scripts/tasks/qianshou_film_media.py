"""Official one-cell executor: call Shanghai, then poll the same task. No GPU retry."""
import json
import os
import re
import sys
import time
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler
from urllib.error import HTTPError

ORIGIN = 'https://www.qianshousuanli.com'
PREFIX = '/api/v8/apps/qianshou-film/media-executor/'
MAX_RESPONSE = 512 * 1024
MAX_ERROR_RESPONSE = 2048
HTTP_ERROR_DETAILS = {
    403: frozenset(('MEDIA_TASK_GRANT_REQUIRED', 'MEDIA_EXECUTION_REJECTED')),
    404: frozenset(('MEDIA_ACTION_NOT_FOUND',)),
    409: frozenset(('MEDIA_STATUS_UNCERTAIN_DO_NOT_RESEND',)),
    413: frozenset(('MEDIA_CONTEXT_LIMIT',)),
    502: frozenset(('MEDIA_RESULT_INVALID',)),
    503: frozenset(('MEDIA_EXECUTION_UNCERTAIN_DO_NOT_RESEND', 'MEDIA_RESULT_READ_RETRYABLE')),
}
MAX_POLL_RECOVERY = 2
MAX_TOTAL_POLL_RECOVERY = 6
TASK_DEADLINE_SECONDS = 1500


class MediaResultReadRetryable(ValueError):
    """Only a bounded, authenticated API 503 with the exact static code."""
    pass
PLATFORM_HTTP_CODES = {
    403: 'AUTH_PERMISSION_DENIED', 404: 'RESOURCE_NOT_FOUND',
    409: 'RESOURCE_CONFLICT', 413: 'INTERNAL_ERROR',
    502: 'INTERNAL_ERROR', 503: 'INTERNAL_ERROR',
}


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def http_error_code(error):
    """Read only a bounded known static detail; never return an arbitrary body."""
    status = error.code if type(error.code) is int and 100 <= error.code <= 599 else 0
    fallback = 'MEDIA_REQUEST_REJECTED_' + str(status)
    try:
        raw = error.read(MAX_ERROR_RESPONSE + 1)
        if len(raw) > MAX_ERROR_RESPONSE:
            return fallback
        # A list of pairs rejects duplicate/extra keys as well as non-object JSON.
        value = json.loads(raw, object_pairs_hook=lambda pairs: pairs)
        if (type(value) is list and len(value) == 1 and type(value[0]) is tuple
            and value[0][0] == 'detail' and type(value[0][1]) is str
            and value[0][1] in HTTP_ERROR_DETAILS.get(status, ())):
            return value[0][1]
        # Shanghai's real global HTTP handler replaces FastAPI detail with this
        # exact envelope. Accept only the same static message/status whitelist;
        # never log its trace ID, code, arbitrary message or extra fields.
        if (type(value) is list and len(value) == 4
            and all(type(pair) is tuple and len(pair) == 2 for pair in value)):
            fields = dict(value)
            if (set(fields) == {'ok', 'code', 'message', 'trace_id'} and fields['ok'] is False
                and fields['code'] == PLATFORM_HTTP_CODES.get(status)
                and type(fields['trace_id']) is str and len(fields['trace_id']) <= 128
                and type(fields['message']) is str and fields['message'] in HTTP_ERROR_DETAILS.get(status, ())):
                return fields['message']
    except Exception:
        pass
    finally:
        try:
            error.close()
        except Exception:
            pass
    return fallback


def request(action, context, token, *, timeout_s=180):
    if action not in ('start', 'poll'):
        raise ValueError('INVALID_MEDIA_ACTION')
    raw = json.dumps(context, ensure_ascii=False, allow_nan=False).encode()
    message = Request(ORIGIN + PREFIX + action, data=raw, method='POST',
        headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    opener = build_opener(ProxyHandler({}), NoRedirect())
    try:
        with opener.open(message, timeout=timeout_s) as response:
            data = response.read(MAX_RESPONSE + 1)
            if len(data) > MAX_RESPONSE:
                raise ValueError('MEDIA_RESPONSE_LIMIT')
            result = json.loads(data)
            if type(result) is not dict:
                raise ValueError('MEDIA_RESPONSE_INVALID')
            return result
    except HTTPError as error:
        # Never echo an upstream body, credential or URL query to worker logs.
        code = http_error_code(error)
        if error.code == 503 and code == 'MEDIA_RESULT_READ_RETRYABLE':
            raise MediaResultReadRetryable(code) from None
        raise ValueError(code) from None


def execute(params, call=None, *, now=time.monotonic, sleep=time.sleep):
    token = params.get('api_key')
    context = params.get('_media_execution')
    if (not isinstance(token, str) or len(token) != 43 or type(context) is not dict
        or set(context) != {'workloadId', 'shardId', 'workerId', 'attempt', 'leaseToken'}):
        raise ValueError('SERVER_MEDIA_ASSIGNMENT_REQUIRED')
    deadline = now() + TASK_DEADLINE_SECONDS
    def remaining():
        seconds = deadline - now()
        if seconds <= 0:
            raise ValueError('MEDIA_TIMEOUT_DO_NOT_RESEND')
        return seconds
    def invoke(action):
        budget = remaining()
        value = (request(action, context, token, timeout_s=min(180, budget))
                 if call is None else call(action, context, token))
        remaining()  # Never accept a result or make another call after expiry.
        return value
    def pause(seconds):
        if remaining() <= seconds:
            raise ValueError('MEDIA_TIMEOUT_DO_NOT_RESEND')
        sleep(seconds)
        remaining()
    value = invoke('start')  # Exactly one possible GPU submission; never retried.
    known_job_id = None
    recovery_count = 0
    while True:
        if value.get('schema') == 'film-production-media-result.v3' and value.get('status') == 'succeeded':
            scope = value.get('execution', {})
            if (scope.get('workloadId') != context['workloadId'] or scope.get('shardId') != context['shardId']
                or scope.get('executorWorkerId') != context['workerId'] or scope.get('attempt') != context['attempt']
                or known_job_id is not None and value.get('logicalJobId') != known_job_id):
                raise ValueError('MEDIA_RESULT_ASSIGNMENT_MISMATCH')
            return value
        if value.get('state') != 'processing' or value.get('retrySubmit') is not False:
            raise ValueError('MEDIA_STATUS_UNCERTAIN_DO_NOT_RESEND')
        logical_job_id = value.get('logicalJobId')
        if (not isinstance(logical_job_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', logical_job_id)
            or known_job_id is not None and logical_job_id != known_job_id):
            raise ValueError('MEDIA_RESULT_ASSIGNMENT_MISMATCH')
        known_job_id = logical_job_id
        pause(3)
        consecutive_recoveries = 0
        while True:
            try:
                value = invoke('poll')
                break
            except MediaResultReadRetryable:
                # At most two extra reads per logical poll, six for the task.
                # A healthy processing response resets only the consecutive count.
                if consecutive_recoveries >= MAX_POLL_RECOVERY or recovery_count >= MAX_TOTAL_POLL_RECOVERY:
                    raise
                consecutive_recoveries += 1
                recovery_count += 1
                pause(2 * consecutive_recoveries)


def main():
    try:
        params = json.loads(os.environ.get('EC_PARAMS', '{}'))
        result = execute(params)
        print(json.dumps(result, ensure_ascii=False, allow_nan=False))
        return 0
    except Exception as error:
        # The original worker owns the failure envelope and attempt identity.
        code = str(error) if isinstance(error, ValueError) and str(error).startswith(('MEDIA_', 'SERVER_MEDIA_')) else 'MEDIA_EXECUTION_UNCERTAIN_DO_NOT_RESEND'
        print(code, file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())

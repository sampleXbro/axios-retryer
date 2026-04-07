import axios from 'axios';

import { AxiosRetryerError } from '../../core/errors/AxiosRetryerError';
import { TokenRefreshFailedError } from './TokenRefreshFailedError';
import { TokenRefreshTimeoutError } from './TokenRefreshTimeoutError';

export class TokenRefreshAbortError extends AxiosRetryerError {
  public readonly stopRefreshRetries = true;

  constructor(message = 'Token refresh aborted') {
    super(message, 'ETOKEN_REFRESH_ABORTED');
  }
}

export function shouldStopRefreshRetries(error: unknown): error is TokenRefreshAbortError {
  if (error instanceof TokenRefreshAbortError) {
    return true;
  }

  if (typeof error !== 'object' || error === null) {
    return false;
  }

  return 'stopRefreshRetries' in error && error.stopRefreshRetries === true;
}

type RetryableRefreshFailure = {
  retryableRefreshFailure?: boolean;
  isAxiosError?: boolean;
  request?: unknown;
  response?: unknown;
};

type TokenRefreshErrorCandidate = Record<string, unknown> & {
  cause?: unknown;
  code?: unknown;
  message?: unknown;
  request?: unknown;
  response?: unknown;
  status?: unknown;
};

function assignKnownErrorFields(
  error: TokenRefreshFailedError,
  candidate: TokenRefreshErrorCandidate,
): TokenRefreshFailedError {
  const mutableError = error as TokenRefreshFailedError & {
    cause?: unknown;
    code: string;
    request?: unknown;
    response?: unknown;
    status?: unknown;
  };

  if (typeof candidate.code === 'string' && candidate.code.length > 0) {
    mutableError.code = candidate.code;
  }

  if ('cause' in candidate) {
    mutableError.cause = candidate.cause;
  }

  if ('request' in candidate) {
    mutableError.request = candidate.request;
  }

  if ('response' in candidate) {
    mutableError.response = candidate.response;
  }

  if ('status' in candidate) {
    mutableError.status = candidate.status;
  }

  return error;
}

export function shouldRetryRefreshError(error: unknown): boolean {
  if (error instanceof TokenRefreshAbortError) {
    return false;
  }

  if (axios.isAxiosError(error)) {
    return true;
  }

  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as RetryableRefreshFailure;

  if (candidate.retryableRefreshFailure === true) {
    return true;
  }

  return candidate.isAxiosError === true || 'request' in candidate || 'response' in candidate;
}

export function toTokenRefreshError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  if (typeof error === 'object' && error !== null) {
    const candidate = error as TokenRefreshErrorCandidate;
    const message =
      typeof candidate.message === 'string' && candidate.message.length > 0
        ? candidate.message
        : 'Token refresh failed';

    return assignKnownErrorFields(new TokenRefreshFailedError(message), candidate);
  }

  if (typeof error === 'string' && error.length > 0) {
    return new TokenRefreshFailedError(error);
  }

  return new TokenRefreshFailedError();
}

export function createRetryableRefreshError(message: string): TokenRefreshTimeoutError {
  return new TokenRefreshTimeoutError(message);
}

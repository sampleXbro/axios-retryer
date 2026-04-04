import axios from 'axios';

export class TokenRefreshAbortError extends Error {
  public readonly stopRefreshRetries = true;

  constructor(message = 'Token refresh aborted') {
    super(message);
    this.name = 'TokenRefreshAbortError';
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
    const candidate = error as Record<string, unknown> & { message?: unknown };
    const message =
      typeof candidate.message === 'string' && candidate.message.length > 0
        ? candidate.message
        : 'Token refresh failed';

    return Object.assign(new Error(message), candidate);
  }

  if (typeof error === 'string' && error.length > 0) {
    return new Error(error);
  }

  return new Error('Token refresh failed');
}

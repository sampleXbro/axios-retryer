import { RetryManager } from '../../core/RetryManager';
import { RetryPlugin } from '../../types';

/**
 * Configuration options for the Circuit Breaker behavior.
 */
export interface CircuitBreakerOptions {
  /**
   * Number of consecutive failures required to trip the circuit.
   * Once this threshold is exceeded, the circuit transitions from `CLOSED` to `OPEN`.
   */
  failureThreshold: number;

  /**
   * Duration (in milliseconds) the circuit remains in the `OPEN` state
   * before allowing a test request in the `HALF_OPEN` state.
   */
  openTimeout: number;

  /**
   * Maximum number of test requests allowed in `HALF_OPEN` state
   * before deciding to either reset (back to `CLOSED`) or trip again to `OPEN`.
   */
  halfOpenMax: number;
}

/**
 * CircuitBreakerPlugin
 *
 * This plugin implements the Circuit Breaker pattern by temporarily stopping retries if a service
 * appears to be down. When too many consecutive failures occur, the circuit "trips" (opens) and all
 * incoming requests are immediately rejected (fail-fast). After a cool-down period, the circuit transitions
 * to a half-open state and allows a limited number of test requests. A successful test resets the circuit,
 * while a failure reopens it.
 *
 * @implements {RetryPlugin}
 */
export class CircuitBreakerPlugin implements RetryPlugin {
  public readonly name = 'CircuitBreakerPlugin';
  public readonly version = '1.0.0';

  private _options: CircuitBreakerOptions;
  private _state = CircuitBreakerPlugin.STATES.CLOSED;
  private _failureCount: number;
  private _halfOpenCount: number;
  private _nextAttempt: number;
  // These will hold our interceptor IDs.
  private _requestInterceptorId?: number;
  private _responseInterceptorId?: number;
  // This will hold the manager instance once initialized.
  private _manager!: RetryManager;

  // Define circuit states as static constants.
  static STATES = {
    CLOSED: 'CLOSED',
    OPEN: 'OPEN',
    HALF_OPEN: 'HALF_OPEN',
  };

  /**
   * Creates an instance of CircuitBreakerPlugin.
   * @param {Partial<CircuitBreakerOptions>} [options] - Configuration options.
   *   - failureThreshold: Number of consecutive failures to trip the circuit (default: 5).
   *   - openTimeout: Time (in ms) the circuit remains open before transitioning to half-open (default: 30000).
   *   - halfOpenMax: Maximum number of test requests allowed in the half-open state (default: 1).
   */
  constructor(options: Partial<CircuitBreakerOptions> = {}) {
    const defaults: CircuitBreakerOptions = {
      failureThreshold: 5,
      openTimeout: 30000,
      halfOpenMax: 1,
    };

    // Initialize private fields.
    this._options = { ...defaults, ...options };
    this._state = CircuitBreakerPlugin.STATES.CLOSED;
    this._failureCount = 0;
    this._halfOpenCount = 0;
    this._nextAttempt = Date.now();
  }

  /**
   * Initializes the plugin by setting up request and response interceptors.
   * Called when the plugin is attached.
   *
   * @param {RetryManager} manager - The RetryManager instance.
   */
  public initialize(manager: RetryManager): void {
    this._manager = manager;
    const axiosInstance = manager.axiosInstance;

    // Request interceptor:
    // - If the circuit is OPEN, check if the cool-down period has elapsed. If yes, transition to HALF_OPEN.
    //   Otherwise, immediately reject the request.
    // - If the circuit is HALF_OPEN, allow only a limited number of test requests.
    this._requestInterceptorId = axiosInstance.interceptors.request.use((config) => {
      if (this._state === CircuitBreakerPlugin.STATES.OPEN) {
        if (Date.now() >= this._nextAttempt) {
          this._transitionToHalfOpen();
        } else {
          return Promise.reject(new Error('Circuit is open: failing fast.'));
        }
      }

      if (this._state === CircuitBreakerPlugin.STATES.HALF_OPEN) {
        if (this._halfOpenCount >= this._options.halfOpenMax) {
          return Promise.reject(new Error('Circuit is half-open: too many test requests.'));
        }
        this._halfOpenCount++;
      }

      return config;
    });

    // Response interceptor:
    // - On a successful response in HALF_OPEN state, reset the circuit.
    // - On a successful response in CLOSED state, reset the failure counter.
    // - On an error, increment the failure counter and, if in HALF_OPEN or if the threshold is reached, trip the circuit.
    this._responseInterceptorId = axiosInstance.interceptors.response.use(
      (response) => {
        if (this._state === CircuitBreakerPlugin.STATES.HALF_OPEN) {
          this._reset();
        } else if (this._state === CircuitBreakerPlugin.STATES.CLOSED) {
          this._failureCount = 0;
        }
        return response;
      },
      (error) => {
        this._failureCount++;

        if (
          this._state === CircuitBreakerPlugin.STATES.HALF_OPEN ||
          this._failureCount >= this._options.failureThreshold
        ) {
          this._trip();
        }
        return Promise.reject(error);
      }
    );
  }

  /**
   * Called before the plugin is removed.
   * Ejects the interceptors.
   *
   * @param {RetryManager} manager - The RetryManager instance.
   */
  public onBeforeDestroyed(manager: RetryManager): void {
    const axiosInstance = manager.axiosInstance;
    if (this._requestInterceptorId !== undefined) {
      axiosInstance.interceptors.request.eject(this._requestInterceptorId);
    }
    if (this._responseInterceptorId !== undefined) {
      axiosInstance.interceptors.response.eject(this._responseInterceptorId);
    }
  }

  /**
   * Trips the circuit by transitioning it to OPEN state.
   * Sets the next attempt time based on the openTimeout option.
   */
  private _trip(): void {
    if (this._state !== CircuitBreakerPlugin.STATES.OPEN) {
      this._state = CircuitBreakerPlugin.STATES.OPEN;
      this._nextAttempt = Date.now() + this._options.openTimeout;
      if (this._manager && typeof this._manager.getLogger === 'function') {
        this._manager.getLogger().error(`${this.name} tripped: entering OPEN state.`);
      }
    }
  }

  /**
   * Resets the circuit by transitioning it back to CLOSED state.
   */
  private _reset(): void {
    this._state = CircuitBreakerPlugin.STATES.CLOSED;
    this._failureCount = 0;
    this._halfOpenCount = 0;
    if (this._manager && typeof this._manager.getLogger === 'function') {
      this._manager.getLogger().debug(`${this.name} reset: entering CLOSED state.`);
    }
  }

  /**
   * Transitions the circuit to HALF_OPEN state, allowing test requests.
   */
  private _transitionToHalfOpen(): void {
    this._state = CircuitBreakerPlugin.STATES.HALF_OPEN;
    this._halfOpenCount = 0;
    if (this._manager && typeof this._manager.getLogger === 'function') {
      this._manager.getLogger().debug(`${this.name} transitioning to HALF_OPEN state.`);
    }
  }
}
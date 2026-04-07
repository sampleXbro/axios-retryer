import { AxiosRetryerError } from './errors/AxiosRetryerError';

export type SleepHandle = {
  promise: Promise<void>;
  cancel: () => void;
};

export class TimerManager {
  private activeTimers = new Set<ReturnType<typeof setTimeout>>();
  private activeSleepRejects = new Set<(err: Error) => void>();
  private isDestroyed = false;

  public createTimeout(
    callback: () => void,
    delay: number,
  ): { timerId: ReturnType<typeof setTimeout> | null; cancel: () => void } {
    if (this.isDestroyed) {
      // Silently discard — do not fire the callback on a destroyed manager.
      return { timerId: null, cancel: () => {} };
    }

    const timerId = setTimeout(() => {
      this.activeTimers.delete(timerId);
      if (!this.isDestroyed) {
        callback();
      }
    }, delay);

    this.activeTimers.add(timerId);

    return {
      timerId,
      cancel: () => {
        if (this.activeTimers.has(timerId)) {
          clearTimeout(timerId);
          this.activeTimers.delete(timerId);
        }
      },
    };
  }

  public createSleep(ms: number): SleepHandle {
    let cancelFn: () => void = () => {};

    const promise = new Promise<void>((resolve, reject) => {
      if (this.isDestroyed) {
        reject(new AxiosRetryerError('Sleep cancelled', 'ETIMER_CANCELLED'));
        return;
      }

      const rejectSleep = (err: Error): void => {
        this.activeSleepRejects.delete(rejectSleep);
        reject(err);
      };
      this.activeSleepRejects.add(rejectSleep);

      const { cancel } = this.createTimeout(() => {
        this.activeSleepRejects.delete(rejectSleep);
        resolve();
      }, ms);

      cancelFn = () => {
        cancel();
        rejectSleep(new AxiosRetryerError('Sleep cancelled', 'ETIMER_CANCELLED'));
      };
    });

    return { promise, cancel: cancelFn };
  }

  public getActiveTimerCount(): number {
    return this.activeTimers.size;
  }

  public destroy(): void {
    this.isDestroyed = true;
    this.activeTimers.forEach((timerId) => {
      clearTimeout(timerId);
    });
    this.activeTimers.clear();

    const err = new AxiosRetryerError('Sleep cancelled', 'ETIMER_CANCELLED');
    this.activeSleepRejects.forEach((rejectSleep) => rejectSleep(err));
    this.activeSleepRejects.clear();
  }
}

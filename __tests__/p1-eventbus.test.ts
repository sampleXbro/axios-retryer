/**
 * P1 coverage for TEST_GAP_ANALYSIS.md §8 EventBus (listener management + emission).
 */
import type { Logger } from '../src/types';
import { EventBus } from '../src/core/EventBus';

function createTestLogger(): Logger & { debug: jest.Mock; warn: jest.Mock; error: jest.Mock; log: jest.Mock } {
  return {
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    log: jest.fn(),
  };
}

describe('P1 EventBus (§8.1–8.2)', () => {
  describe('§8.1 Listener management', () => {
    it('8.1.1 on + off with same reference removes the listener', () => {
      const logger = createTestLogger();
      const bus = new EventBus(logger);
      const fn = jest.fn();
      bus.on('onRetryProcessFinished', fn);
      bus.emit('onRetryProcessFinished');
      expect(fn).toHaveBeenCalledTimes(1);
      expect(bus.off('onRetryProcessFinished', fn)).toBe(true);
      bus.emit('onRetryProcessFinished');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('8.1.2 off with listener never added returns false', () => {
      const bus = new EventBus(createTestLogger());
      expect(bus.off('onRetryProcessFinished', jest.fn())).toBe(false);
    });

    it('8.1.3 off with different function reference returns false', () => {
      const bus = new EventBus(createTestLogger());
      bus.on('onRetryProcessFinished', () => {});
      expect(bus.off('onRetryProcessFinished', () => {})).toBe(false);
    });

    it('8.1.4 adding the same listener twice — both fire', () => {
      const bus = new EventBus(createTestLogger());
      const fn = jest.fn();
      bus.on('onRetryProcessFinished', fn);
      bus.on('onRetryProcessFinished', fn);
      bus.emit('onRetryProcessFinished');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('8.1.5 removing duplicated listener removes only first occurrence', () => {
      const bus = new EventBus(createTestLogger());
      const fn = jest.fn();
      bus.on('onRetryProcessFinished', fn);
      bus.on('onRetryProcessFinished', fn);
      bus.off('onRetryProcessFinished', fn);
      bus.emit('onRetryProcessFinished');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('8.1.6 at maxListenersPerEvent the next on is dropped and logs a warning', () => {
      const logger = createTestLogger();
      const bus = new EventBus(logger, 3);
      const fns = [jest.fn(), jest.fn(), jest.fn()];
      fns.forEach((f) => bus.on('onRetryProcessFinished', f));
      bus.on('onRetryProcessFinished', jest.fn());
      expect(logger.warn).toHaveBeenCalled();
      bus.emit('onRetryProcessFinished');
      expect(fns.every((f) => f.mock.calls.length === 1)).toBe(true);
    });
  });

  describe('§8.2 Emission behavior', () => {
    it('8.2.1 listener throw does not prevent subsequent listeners', () => {
      const logger = createTestLogger();
      const bus = new EventBus(logger);
      const second = jest.fn();
      bus.on('onRetryProcessFinished', () => {
        throw new Error('boom');
      });
      bus.on('onRetryProcessFinished', second);
      bus.emit('onRetryProcessFinished');
      expect(second).toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalled();
    });

    it('8.2.3 emitting with no listeners is a no-op', () => {
      const bus = new EventBus(createTestLogger());
      expect(() => bus.emit('onRetryProcessFinished')).not.toThrow();
    });

    it('8.2.4 listener receives all emit arguments', () => {
      const bus = new EventBus(createTestLogger());
      const fn = jest.fn();
      bus.on('onRequestCancelled', fn);
      bus.emit('onRequestCancelled', 'req_abc');
      expect(fn).toHaveBeenCalledWith('req_abc');
    });

    it('8.2.5 triggerAndEmit matches emit', () => {
      const bus = new EventBus(createTestLogger());
      const a = jest.fn();
      const b = jest.fn();
      bus.on('onRetryProcessFinished', a);
      bus.on('onRetryProcessFinished', b);
      bus.emit('onRetryProcessFinished');
      bus.triggerAndEmit('onRetryProcessFinished');
      expect(a).toHaveBeenCalledTimes(2);
      expect(b).toHaveBeenCalledTimes(2);
    });

    it('8.2.6 clear removes all listeners', () => {
      const bus = new EventBus(createTestLogger());
      bus.on('onRetryProcessFinished', jest.fn());
      bus.on('onRequestCancelled', jest.fn());
      bus.clear();
      expect(bus.hasListeners('onRetryProcessFinished')).toBe(false);
      expect(bus.hasListeners('onRequestCancelled')).toBe(false);
    });

    it('8.2.7 hasListeners reflects registration state', () => {
      const bus = new EventBus(createTestLogger());
      const fn = jest.fn();
      expect(bus.hasListeners('onRetryProcessFinished')).toBe(false);
      bus.on('onRetryProcessFinished', fn);
      expect(bus.hasListeners('onRetryProcessFinished')).toBe(true);
      bus.off('onRetryProcessFinished', fn);
      expect(bus.hasListeners('onRetryProcessFinished')).toBe(false);
    });
  });
});

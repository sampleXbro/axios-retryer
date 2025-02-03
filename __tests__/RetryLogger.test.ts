import { RetryLogger } from '../src/services/logger';

describe('RetryLogger', () => {
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let consoleWarnSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('when logging is disabled', () => {
    const logger = new RetryLogger(false);

    it('should not log messages', () => {
      logger.log('Test log');
      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    });

    it('should not log errors', () => {
      logger.error('Test error', new Error('Test'));
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    });

    it('should not log warnings', () => {
      logger.warn('Test warning');
      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('when logging is enabled', () => {
    const logger = new RetryLogger(true);

    it('should log messages with optional data', () => {
      logger.log('Test log', { key: 'value' });
      expect(consoleLogSpy).toHaveBeenCalledWith('[AXIOS_RETRYER] Test log', JSON.stringify({ key: 'value' }));

      logger.log('Test log without data');
      expect(consoleLogSpy).toHaveBeenCalledWith('[AXIOS_RETRYER] Test log without data', '');
    });

    it('should log errors', () => {
      const error = new Error('Test error');
      logger.error('Test error', error);
      expect(consoleErrorSpy).toHaveBeenCalledWith('[AXIOS_RETRYER] Test error', error);
    });

    it('should log warnings with optional data', () => {
      logger.warn('Test warning', { key: 'value' });
      expect(consoleWarnSpy).toHaveBeenCalledWith('[AXIOS_RETRYER] Test warning', JSON.stringify({ key: 'value' }));

      logger.warn('Test warning without data');
      expect(consoleWarnSpy).toHaveBeenCalledWith('[AXIOS_RETRYER] Test warning without data', '');
    });
  });
});
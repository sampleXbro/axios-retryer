import { RetryLogger } from '../src/services/logger';

describe('RetryLogger', () => {
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let consoleWarnSpy: jest.SpyInstance;
  let consoleDebugSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    consoleDebugSpy = jest.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('when debug mode is disabled', () => {
    const logger = new RetryLogger(false);

    it('should log messages', () => {
      logger.log('Test log');
      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    });

    it('should log errors', () => {
      logger.error('Test error', new Error('Test'));
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    });

    it('should log warnings', () => {
      logger.warn('Test warning');
      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    });

    it('should not log debug messages', () => {
      logger.debug('Test debug');
      expect(consoleDebugSpy).not.toHaveBeenCalled();
    });
  });

  describe('when debug mode is enabled', () => {
    const logger = new RetryLogger(true);

    it('should log messages with optional data', () => {
      const data = { key: 'value' };
      logger.log('Test log', data);
      expect(consoleLogSpy).toHaveBeenCalledWith('[AXIOS_RETRYER] Test log', data);

      logger.log('Test log without data');
      expect(consoleLogSpy).toHaveBeenCalledWith('[AXIOS_RETRYER] Test log without data');
    });

    it('should log errors', () => {
      const error = new Error('Test error');
      logger.error('Test error', error);
      expect(consoleErrorSpy).toHaveBeenCalledWith('[AXIOS_RETRYER] Test error', error);
    });

    it('should log warnings with optional data', () => {
      const data = { key: 'value' };
      logger.warn('Test warning', data);
      expect(consoleWarnSpy).toHaveBeenCalledWith('[AXIOS_RETRYER] Test warning', data);

      logger.warn('Test warning without data');
      expect(consoleWarnSpy).toHaveBeenCalledWith('[AXIOS_RETRYER] Test warning without data');
    });

    it('should log debug messages', () => {
      const meta = { step: 'init' };
      logger.debug('Debug msg', meta);
      expect(consoleDebugSpy).toHaveBeenCalledWith('[AXIOS_RETRYER] Debug msg', meta);
    });
  });

  describe('data omission', () => {
    const logger = new RetryLogger(true);

    it('should not pass extra arguments when data is undefined', () => {
      logger.log('No data');
      expect(consoleLogSpy).toHaveBeenCalledWith('[AXIOS_RETRYER] No data');

      logger.warn('No data');
      expect(consoleWarnSpy).toHaveBeenCalledWith('[AXIOS_RETRYER] No data');

      logger.error('No data');
      expect(consoleErrorSpy).toHaveBeenCalledWith('[AXIOS_RETRYER] No data');
    });
  });
});

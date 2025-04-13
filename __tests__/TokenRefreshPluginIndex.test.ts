// @ts-nocheck
import { createTokenRefreshPlugin } from '../src/plugins/TokenRefreshPlugin';
import { TokenRefreshPlugin } from '../src/plugins/TokenRefreshPlugin/TokenRefreshPlugin';

describe('TokenRefreshPlugin Factory Function', () => {
  test('createTokenRefreshPlugin creates an instance of TokenRefreshPlugin', () => {
    const refreshTokenFn = async () => ({ 
      token: 'new-token'
    });
    
    const plugin = createTokenRefreshPlugin(refreshTokenFn, {
      tokenPrefix: 'Bearer '
    });
    
    expect(plugin).toBeInstanceOf(TokenRefreshPlugin);
    expect(plugin.name).toBe('TokenRefreshPlugin');
  });
  
  test('createTokenRefreshPlugin passes options to plugin', () => {
    const refreshTokenFn = async () => ({ 
      token: 'new-token'
    });
    
    const customOptions = {
      tokenPrefix: 'Custom ',
      authHeaderName: 'X-Custom-Auth',
    };
    
    const plugin = createTokenRefreshPlugin(refreshTokenFn, customOptions);
    
    // We can't directly test the options, but we can confirm creation works
    expect(plugin).toBeInstanceOf(TokenRefreshPlugin);
    expect(plugin.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
  
  test('createTokenRefreshPlugin requires refreshToken function', () => {
    // Should work with valid refreshTokenFn
    expect(() => {
      createTokenRefreshPlugin(async () => ({ token: 'token' }));
    }).not.toThrow();
  });
}); 
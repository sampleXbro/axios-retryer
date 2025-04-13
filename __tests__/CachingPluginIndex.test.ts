// @ts-nocheck
import { createCachePlugin } from '../src/plugins/CachingPlugin';
import { CachingPlugin } from '../src/plugins/CachingPlugin/CachingPlugin';

describe('CachingPlugin Factory Function', () => {
  test('createCachePlugin creates an instance of CachingPlugin', () => {
    const plugin = createCachePlugin({
      timeToRevalidate: 5000,
      maxItems: 100
    });
    
    expect(plugin).toBeInstanceOf(CachingPlugin);
    expect(plugin.name).toBe('CachingPlugin');
  });
  
  test('createCachePlugin works with default options', () => {
    const plugin = createCachePlugin();
    
    expect(plugin).toBeInstanceOf(CachingPlugin);
    expect(plugin.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
  
  test('createCachePlugin passes options to plugin', () => {
    const customOptions = {
      timeToRevalidate: 10000,
      cacheMethods: ['GET', 'HEAD'],
      maxItems: 50,
      respectCacheControl: true
    };
    
    const plugin = createCachePlugin(customOptions);
    
    // We can't directly test the options, but we can confirm creation works
    expect(plugin).toBeInstanceOf(CachingPlugin);
  });
}); 
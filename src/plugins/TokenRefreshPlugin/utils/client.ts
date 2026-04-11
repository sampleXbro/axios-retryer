import type { AxiosInstance } from 'axios';
import axios from 'axios';

export function createRefreshAxios(context: { axiosInstance: AxiosInstance }, refreshTimeout: number): AxiosInstance {
  const defaults = context.axiosInstance.defaults;

  return axios.create({
    adapter: defaults.adapter,
    baseURL: defaults.baseURL,
    timeout: refreshTimeout,
    withCredentials: defaults.withCredentials,
    httpAgent: defaults.httpAgent,
    httpsAgent: defaults.httpsAgent,
    proxy: defaults.proxy,
    socketPath: defaults.socketPath,
    maxRedirects: defaults.maxRedirects,
  });
}

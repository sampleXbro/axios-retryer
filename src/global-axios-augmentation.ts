import 'axios';
import type { AxiosRetryerRequestMetadata } from './types';

declare module 'axios' {
  interface AxiosRequestConfig {
    __axiosRetryer?: AxiosRetryerRequestMetadata;
  }
}

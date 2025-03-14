import { InMemoryRequestStore } from '../src/store/InMemoryRequestStore'

import { AxiosRequestConfig } from 'axios';

describe('InMemoryRequestStore', () => {
    let store: InMemoryRequestStore;
    let mockRequest1: AxiosRequestConfig;
    let mockRequest2: AxiosRequestConfig;

    beforeEach(() => {
        store = new InMemoryRequestStore(100, () => {});
        mockRequest1 = { url: 'http://example.com/request1', method: 'GET', __requestId: 'ID1' } as AxiosRequestConfig;
        mockRequest2 = { url: 'http://example.com/request2', method: 'POST', __requestId: 'ID2' } as AxiosRequestConfig;
    });

    describe('add', () => {
        it('should add a request to the store', () => {
            store.add(mockRequest1);
            expect(store.getAll()).toContain(mockRequest1);
        });

        it('should add multiple requests to the store', () => {
            store.add(mockRequest1);
            store.add(mockRequest2);
            expect(store.getAll()).toContain(mockRequest1);
            expect(store.getAll()).toContain(mockRequest2);
        });
    });

    describe('remove', () => {
        it('should remove a request from the store', () => {
            store.add(mockRequest1);
            store.add(mockRequest2);

            store.remove(mockRequest1);
            expect(store.getAll()).not.toContain(mockRequest1);
            expect(store.getAll()).toContain(mockRequest2);
        });

        it('should not affect the store if the request does not exist', () => {
            store.add(mockRequest1);

            store.remove(mockRequest2); // mockRequest2 is not in the store
            expect(store.getAll()).toContain(mockRequest1);
            expect(store.getAll()).not.toContain(mockRequest2);
        });
    });

    describe('getAll', () => {
        it('should return all requests in the store', () => {
            store.add(mockRequest1);
            store.add(mockRequest2);

            const allRequests = store.getAll();
            expect(allRequests).toEqual([mockRequest1, mockRequest2]);
        });

        it('should return an empty array if the store is empty', () => {
            expect(store.getAll()).toEqual([]);
        });
    });

    describe('clear', () => {
        it('should clear all requests from the store', () => {
            store.add(mockRequest1);
            store.add(mockRequest2);

            store.clear();
            expect(store.getAll()).toEqual([]);
        });

        it('should do nothing if the store is already empty', () => {
            store.clear();
            expect(store.getAll()).toEqual([]);
        });
    });
});
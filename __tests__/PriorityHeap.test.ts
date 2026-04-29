import { PriorityHeap, type HeapItem } from '../src/core/utils/PriorityHeap';

interface NumberItem extends HeapItem {
  id: string;
  priority: number;
}

const compareByPriorityThenInsertion = (a: NumberItem, b: NumberItem): number => {
  if (a.priority !== b.priority) return b.priority - a.priority;
  return (a.insertionOrder ?? 0) - (b.insertionOrder ?? 0);
};

describe('PriorityHeap', () => {
  describe('push and shift', () => {
    it('pops items in priority order (highest first)', () => {
      const heap = new PriorityHeap<NumberItem>(compareByPriorityThenInsertion);
      heap.push({ id: 'a', priority: 1 });
      heap.push({ id: 'b', priority: 5 });
      heap.push({ id: 'c', priority: 3 });

      expect(heap.shift()?.id).toBe('b');
      expect(heap.shift()?.id).toBe('c');
      expect(heap.shift()?.id).toBe('a');
      expect(heap.shift()).toBeUndefined();
    });

    it('preserves insertion order for items with equal priority', () => {
      const heap = new PriorityHeap<NumberItem>(compareByPriorityThenInsertion);
      heap.push({ id: 'a', priority: 2 });
      heap.push({ id: 'b', priority: 2 });
      heap.push({ id: 'c', priority: 2 });

      expect(heap.shift()?.id).toBe('a');
      expect(heap.shift()?.id).toBe('b');
      expect(heap.shift()?.id).toBe('c');
    });
  });

  describe('peek', () => {
    it('returns the head without removing it', () => {
      const heap = new PriorityHeap<NumberItem>(compareByPriorityThenInsertion);
      heap.push({ id: 'low', priority: 1 });
      heap.push({ id: 'high', priority: 10 });

      expect(heap.peek()?.id).toBe('high');
      expect(heap.length).toBe(2);
    });

    it('returns undefined on empty heap', () => {
      const heap = new PriorityHeap<NumberItem>(compareByPriorityThenInsertion);
      expect(heap.peek()).toBeUndefined();
    });
  });

  describe('length', () => {
    it('reflects pushed and shifted items', () => {
      const heap = new PriorityHeap<NumberItem>(compareByPriorityThenInsertion);
      expect(heap.length).toBe(0);
      heap.push({ id: 'a', priority: 1 });
      heap.push({ id: 'b', priority: 1 });
      expect(heap.length).toBe(2);
      heap.shift();
      expect(heap.length).toBe(1);
    });
  });

  describe('clear', () => {
    it('returns all items and empties the heap', () => {
      const heap = new PriorityHeap<NumberItem>(compareByPriorityThenInsertion);
      heap.push({ id: 'a', priority: 1 });
      heap.push({ id: 'b', priority: 2 });

      const cleared = heap.clear();
      expect(cleared).toHaveLength(2);
      expect(heap.length).toBe(0);
      expect(heap.peek()).toBeUndefined();
    });
  });

  describe('removeByRequestId', () => {
    const idExtractor = (item: NumberItem): string | undefined => item.id;

    it('removes a matching item and rebalances the heap', () => {
      const heap = new PriorityHeap<NumberItem>(compareByPriorityThenInsertion, idExtractor);
      heap.push({ id: 'a', priority: 5 });
      heap.push({ id: 'b', priority: 3 });
      heap.push({ id: 'c', priority: 4 });

      const removed = heap.removeByRequestId('b');
      expect(removed?.id).toBe('b');
      expect(heap.length).toBe(2);
      expect(heap.shift()?.id).toBe('a');
      expect(heap.shift()?.id).toBe('c');
    });

    it('returns undefined when no match is found', () => {
      const heap = new PriorityHeap<NumberItem>(compareByPriorityThenInsertion, idExtractor);
      heap.push({ id: 'x', priority: 1 });
      expect(heap.removeByRequestId('y')).toBeUndefined();
    });

    it('returns undefined when no extractor was provided', () => {
      const heap = new PriorityHeap<NumberItem>(compareByPriorityThenInsertion);
      heap.push({ id: 'a', priority: 1 });
      expect(heap.removeByRequestId('a')).toBeUndefined();
    });
  });

  describe('getAll', () => {
    it('returns a sorted snapshot without mutating the heap', () => {
      const heap = new PriorityHeap<NumberItem>(compareByPriorityThenInsertion);
      heap.push({ id: 'a', priority: 1 });
      heap.push({ id: 'b', priority: 3 });
      heap.push({ id: 'c', priority: 2 });

      const sorted = heap.getAll();
      expect(sorted.map((s) => s.id)).toEqual(['b', 'c', 'a']);
      expect(heap.length).toBe(3);
    });

    it('caches between calls and invalidates on mutation', () => {
      const heap = new PriorityHeap<NumberItem>(compareByPriorityThenInsertion);
      heap.push({ id: 'a', priority: 1 });
      const first = heap.getAll();
      const second = heap.getAll();
      expect(first).not.toBe(second); // returns a fresh array each call
      expect(first).toEqual(second);

      heap.push({ id: 'b', priority: 5 });
      const afterMutation = heap.getAll();
      expect(afterMutation.map((s) => s.id)).toEqual(['b', 'a']);
    });
  });

  describe('insertionOrder', () => {
    it('assigns monotonically increasing insertionOrder', () => {
      const heap = new PriorityHeap<NumberItem>(compareByPriorityThenInsertion);
      const a: NumberItem = { id: 'a', priority: 1 };
      const b: NumberItem = { id: 'b', priority: 1 };
      heap.push(a);
      heap.push(b);
      expect(a.insertionOrder).toBe(0);
      expect(b.insertionOrder).toBe(1);
    });

    it('resets the insertion counter after clear()', () => {
      const heap = new PriorityHeap<NumberItem>(compareByPriorityThenInsertion);
      heap.push({ id: 'a', priority: 1 });
      heap.clear();
      const next: NumberItem = { id: 'b', priority: 1 };
      heap.push(next);
      expect(next.insertionOrder).toBe(0);
    });
  });
});

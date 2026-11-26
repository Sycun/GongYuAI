import assert from "node:assert/strict";
import test from "node:test";
import { sliceClientPage } from "./useClientPagination";

test("sliceClientPage keeps requested page across refreshed arrays of equal or larger size", () => {
  const initial = Array.from({ length: 21 }, (_, i) => ({ id: i + 1 }));
  const page2 = sliceClientPage(initial, 2, 20);
  assert.equal(page2.currentPage, 2);
  assert.equal(page2.total, 21);
  assert.equal(page2.totalPages, 2);
  assert.deepEqual(page2.dataSource, [{ id: 21 }]);

  const polled = Array.from({ length: 23 }, (_, i) => ({ id: i + 1 }));
  const page2AfterPoll = sliceClientPage(polled, page2.currentPage, 20);
  assert.equal(page2AfterPoll.currentPage, 2);
  assert.equal(page2AfterPoll.total, 23);
  assert.deepEqual(page2AfterPoll.dataSource, [{ id: 21 }, { id: 22 }, { id: 23 }]);
});

test("sliceClientPage clamps page when data shrinks or page is out of bounds", () => {
  const shrunk = Array.from({ length: 15 }, (_, i) => i + 1);
  const clamped = sliceClientPage(shrunk, 2, 20);
  assert.equal(clamped.currentPage, 1);
  assert.equal(clamped.totalPages, 1);
  assert.equal(clamped.dataSource.length, 15);

  const empty = sliceClientPage([], 3, 20);
  assert.equal(empty.currentPage, 1);
  assert.equal(empty.total, 0);
  assert.equal(empty.totalPages, 1);
  assert.deepEqual(empty.dataSource, []);

  const low = sliceClientPage(shrunk, 0, 20);
  assert.equal(low.currentPage, 1);
});

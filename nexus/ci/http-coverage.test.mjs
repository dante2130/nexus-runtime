// SPDX-License-Identifier: MIT
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {hasCompleteHttpCoverage} from './http-coverage.mjs';

const complete = {code: 0, timedOut: false, summary: ['CASE body-h2 status=200 protocol=1 bytes=200000', 'SUMMARY checks=125 failures=0']};
test('current HTTP suite including four fragmented reads satisfies both architecture gates', () => {
  assert.equal(hasCompleteHttpCoverage(complete), true);
  for (const name of ['validate-runtime.mjs', 'validate-runtime-arm64.mjs']) {
    const source = fs.readFileSync(new URL(name, import.meta.url), 'utf8');
    assert.ok(source.includes("import {hasCompleteHttpCoverage} from './http-coverage.mjs'"));
    assert.ok(source.includes('!hasCompleteHttpCoverage(http)'));
  }
});
test('old coverage, incomplete output, failures and abnormal exits remain rejected', () => {
  for (const result of [
    {...complete, summary: ['SUMMARY checks=121 failures=0']},
    {...complete, summary: ['SUMMARY checks=124 failures=0']},
    {...complete, summary: ['SUMMARY checks=125 failures=1']},
    {...complete, summary: ['FAIL fragmented-read-fill-async-h2', ...complete.summary]},
    {...complete, summary: [...complete.summary, 'SUMMARY checks=125 failures=0']},
    {...complete, summary: []}, {...complete, summary: null},
    {...complete, code: 1}, {...complete, code: null},
    {...complete, timedOut: true}, {...complete, timedOut: undefined}, null
  ]) assert.equal(hasCompleteHttpCoverage(result), false, JSON.stringify(result));
});

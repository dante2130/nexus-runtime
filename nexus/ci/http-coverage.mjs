// SPDX-License-Identifier: MIT
// Includes the four synchronous/asynchronous fragmented-read checks for HTTP/1 and HTTP/2.
export function hasCompleteHttpCoverage(result) {
  if (result?.code !== 0 || result.timedOut !== false || !Array.isArray(result.summary)) return false;
  if (result.summary.some(line => typeof line !== 'string' || line.startsWith('FAIL '))) return false;
  const summaries = result.summary.filter(line => line.startsWith('SUMMARY '));
  return summaries.length === 1 && summaries[0] === 'SUMMARY checks=125 failures=0';
}

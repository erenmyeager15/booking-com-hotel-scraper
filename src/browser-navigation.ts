import type { PlaywrightHook } from 'crawlee';
import type { SearchState } from './types.js';
import { rejectBookingAccess } from './access-policy.js';
import { restoreSearchState } from './search-state.js';
import { waitForBookingDocument } from './navigation.js';

/** Run before Crawlee persists session cookies or calls the collector. Commit
 * alone never certifies readiness; HTTP denials stop before any further wait. */
export const bookingPostNavigation: PlaywrightHook = async ({ response, request, page }) => {
  if (response && [401, 403, 429].includes(response.status())) {
    rejectBookingAccess(request, restoreSearchState(request.userData.state as SearchState),
      `BOOKING_BLOCKED: HTTP ${response.status()} during navigation`);
  }
  await waitForBookingDocument(page);
};

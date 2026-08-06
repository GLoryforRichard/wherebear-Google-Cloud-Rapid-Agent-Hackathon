/**
 * Shared staff-gate constants so /admin and /admin/queue can never drift
 * apart — one passcode, one sessionStorage unlock key for both.
 */
export const STAFF_PASSCODE = '2627';
export const STAFF_UNLOCK_KEY = 'wherebear:staff-unlocked';

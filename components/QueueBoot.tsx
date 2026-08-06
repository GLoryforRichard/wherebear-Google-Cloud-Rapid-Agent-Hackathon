'use client';

import { useEffect } from 'react';
import { restoreFromOutbox } from '@/lib/scan-queue/pump';

/**
 * Restores the global scan queue from IndexedDB once per app load, so a
 * reload / tab close / iOS process kill resumes in place. Mounted app-wide
 * in the root layout. Restore never auto-reloads the page (StaleClientGuard
 * lesson: a reload kills in-flight uploads) — it resumes where things stood.
 */
export default function QueueBoot() {
  useEffect(() => {
    void restoreFromOutbox();
  }, []);
  return null;
}

import { notFound } from 'next/navigation';
import { isScanLabEnabled } from '@/lib/scan-lab';

/** Server layout gate: production 404s compare / vision-test / cost-lab. */
export default function ScanLabGate({ children }: { children: React.ReactNode }) {
  if (!isScanLabEnabled()) notFound();
  return children;
}

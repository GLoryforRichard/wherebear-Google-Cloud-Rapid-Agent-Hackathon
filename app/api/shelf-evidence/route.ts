import { NextRequest } from 'next/server';
import { DetectedProduct } from '@/lib/gemini';
import { saveShelfDirect, enhanceShelfBackground } from '@/lib/shelf-save';
import { logOp } from '@/lib/ops';
import { EMPTY_USAGE, addUsage, UsageTotals } from '@/lib/cost';

export const runtime = 'nodejs';
// Critical path is a single MongoDB bulkWrite — finishes in well under
// a second. 60s ceiling is just a sanity bound for the SSE setup itself.
export const maxDuration = 60;

interface SaveBody {
  aisle: string;
  products: DetectedProduct[];
}

// Batch shelf scans (15 photos × ~50 SKUs per photo, post-dedup) routinely
// reach 200-300 distinct SKUs. bulkWrite handles thousands of ops in one
// round trip — cap is just a sanity bound against pathological inputs.
const MAX_PRODUCTS_PER_RUN = 400;

function sanitizeProduct(raw: unknown): DetectedProduct | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Partial<DetectedProduct>;
  const name = typeof item.name === 'string' ? item.name.trim() : '';
  if (!name) return null;

  // Thumbnails are 240px JPEG data URLs (~25 KB each). Validate the prefix
  // and cap at 200 KB so a malicious / runaway payload can't bloat the DB.
  let thumbnail: string | undefined;
  if (typeof item.thumbnail === 'string' && item.thumbnail.startsWith('data:image/')) {
    if (item.thumbnail.length <= 200 * 1024) {
      thumbnail = item.thumbnail;
    }
  }

  return {
    name: name.slice(0, 160),
    category: typeof item.category === 'string' ? item.category.slice(0, 60) : undefined,
    confidence: item.confidence,
    thumbnail,
  };
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as SaveBody;
  const aisle = body.aisle?.trim();
  const allProducts = Array.isArray(body.products) ? body.products : [];
  const products = allProducts
    .map(sanitizeProduct)
    .filter((product): product is DetectedProduct => !!product)
    .slice(0, MAX_PRODUCTS_PER_RUN);

  if (!aisle || products.length === 0) {
    return new Response(
      JSON.stringify({ ok: false, error: 'aisle and non-empty products are required' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // iOS Safari kills SSE connections when the tab goes to background.
      // Once that happens controller.enqueue() throws "Cannot enqueue, …".
      // We swallow that error so the agent loop keeps running on the
      // server — products still get written to MongoDB even though the
      // client never sees the trailing events. On reconnect, the client
      // polls /api/admin/products?aisle=… to verify the work landed.
      let clientGone = false;
      let usage: UsageTotals = { ...EMPTY_USAGE };

      const send = (data: object) => {
        if (clientGone) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          clientGone = true;
          console.warn('[shelf-evidence] client disconnected; agent continues server-side');
        }
      };

      try {
        if (allProducts.length > MAX_PRODUCTS_PER_RUN) {
          send({
            type: 'agent_message',
            ts: Date.now(),
            message: `Trimming to first ${MAX_PRODUCTS_PER_RUN} products (you sent ${allProducts.length}).`,
          });
        }
        for await (const event of saveShelfDirect({ aisle, products })) {
          const e = event as { type?: string; usage?: Partial<UsageTotals> };
          if (e.type === 'cost' && e.usage) usage = addUsage(usage, e.usage);
          send(event);
        }
        await logOp('save', usage);
      } catch (err) {
        send({
          type: 'error',
          ts: Date.now(),
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        try { controller.close(); } catch { /* already closed */ }

        // Fire-and-forget alias enhancement. The Node process keeps this
        // promise alive after the SSE response is closed, so the user gets
        // an instant "done" while aliases land 5–10 s later in the
        // background (Atlas Vector Search auto-embedding will re-index).
        enhanceShelfBackground({ aisle, products }).catch(err => {
          console.warn(
            '[shelf-evidence] background alias enhancement failed:',
            err instanceof Error ? err.message : err
          );
        });
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

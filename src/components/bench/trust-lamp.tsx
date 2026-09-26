import { trustLamp } from "@/lib/process-model";
import type { TrustState } from "@/lib/schemas";

/**
 * A labelled indicator lamp for code-signing trust. Colour is one channel;
 * the visible short label and the full accessible label are the others.
 */
export function TrustLamp({ trust, verbose = false }: { trust: TrustState; verbose?: boolean }) {
  const lamp = trustLamp(trust);
  return (
    <span className="lamp" data-state={lamp.state} title={lamp.label}>
      <span aria-hidden="true">{verbose ? lamp.label : lamp.short}</span>
      <span className="sr-only">{lamp.label}</span>
    </span>
  );
}

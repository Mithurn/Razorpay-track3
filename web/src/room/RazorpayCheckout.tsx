import { useEffect, useState } from "react";
import { payInfo } from "../api.js";
import type { PayInfo } from "../api.js";
import { CreditCard } from "../ui/icons.js";

// The customer's own step, brought into the room: once the executor has genuinely created a
// Razorpay order or payment link (never a bench/seeded one — the server excludes those), this
// renders Razorpay's real Checkout widget rather than a stand-in. Completing it fires a real,
// Razorpay-signed webhook through the same handler a production delivery hits.

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open(): void };
  }
}

const CHECKOUT_SRC = "https://checkout.razorpay.com/v1/checkout.js";

let scriptPromise: Promise<void> | null = null;
function loadCheckoutScript(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  scriptPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = CHECKOUT_SRC;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("failed to load Razorpay checkout.js"));
    document.head.appendChild(script);
  });
  return scriptPromise;
}

export function RazorpayCheckout({
  caseId,
  keyId,
  customerRef,
  onPaid,
}: {
  caseId: string;
  keyId: string;
  customerRef: string;
  onPaid: () => void;
}) {
  const [info, setInfo] = useState<PayInfo | null>(null);
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    let cancelled = false;
    payInfo(caseId)
      .then((r) => !cancelled && setInfo(r))
      .catch(() => !cancelled && setInfo({ payable: false }));
    return () => {
      cancelled = true;
    };
  }, [caseId]);

  if (!info?.payable) return null;

  if (info.kind === "payment_link") {
    return (
      <a className="btn btn--primary" href={info.url} target="_blank" rel="noreferrer">
        <CreditCard size={13} /> Open payment link
      </a>
    );
  }

  const open = async () => {
    setOpening(true);
    try {
      await loadCheckoutScript();
      const rzp = new window.Razorpay!({
        key: keyId,
        order_id: info.orderId,
        amount: info.amountPaise,
        currency: info.currency,
        name: "Acme Subscriptions",
        description: "Recovery Room — customer completes payment",
        prefill: { email: customerRef.includes("@") ? customerRef : undefined },
        theme: { color: "#3b82f6" },
        // Razorpay's own webhook is authoritative; this is only for the room's own responsiveness
        // — the case flips to RECOVERED off the signed webhook, not off this callback.
        handler: () => onPaid(),
      });
      rzp.open();
    } finally {
      setOpening(false);
    }
  };

  return (
    <button className="btn btn--primary" onClick={open} disabled={opening}>
      <CreditCard size={13} /> {opening ? "Opening…" : "Customer pays (Razorpay Checkout)"}
    </button>
  );
}

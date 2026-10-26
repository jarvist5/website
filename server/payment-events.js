const paymentIntentId = (value) =>
  typeof value === "string" && /^pi_[A-Za-z0-9_]{1,250}$/.test(value)
    ? value
    : null;

/** Process an already signature-verified provider event. Never call with untrusted JSON. */
export function handlePaymentEvent(store, event) {
  const object = event?.data?.object;
  if (
    event?.type === "checkout.session.completed" ||
    event?.type === "checkout.session.async_payment_succeeded"
  ) {
    if (object?.payment_status !== "paid")
      return { handled: false, matched: true };
    const intent = paymentIntentId(object.payment_intent);
    if (
      !intent ||
      typeof object.id !== "string" ||
      typeof object.metadata?.orderId !== "string" ||
      !Number.isSafeInteger(object.amount_total) ||
      typeof object.currency !== "string"
    )
      return { handled: true, matched: false };
    return {
      handled: true,
      matched: store.markPaid(
        object.metadata.orderId,
        object.id,
        object.amount_total,
        object.currency,
        intent,
      ),
    };
  }
  if (event?.type === "charge.refunded") {
    const fullyRefunded =
      object?.refunded === true ||
      (Number.isSafeInteger(object?.amount) &&
        object.amount > 0 &&
        Number.isSafeInteger(object?.amount_refunded) &&
        object.amount_refunded >= object.amount);
    // A partial refund need not remove the entire multi-product entitlement.
    if (!fullyRefunded) return { handled: false, matched: true };
    const intent = paymentIntentId(object?.payment_intent);
    if (!intent) return { handled: true, matched: false };
    store.revokeByPaymentIntent(intent, "refunded");
    return { handled: true, matched: true };
  }
  if (event?.type === "charge.dispute.created") {
    const intent = paymentIntentId(object?.payment_intent);
    if (!intent) return { handled: true, matched: false };
    // Fail closed, even if this event arrives before the Checkout completion.
    // Restoring a disputed entitlement requires deliberate manual reconciliation.
    store.revokeByPaymentIntent(intent, "disputed");
    return { handled: true, matched: true };
  }
  return { handled: false, matched: true };
}

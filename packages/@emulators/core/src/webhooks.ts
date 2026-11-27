import { createHmac } from "crypto";

export interface WebhookSubscription {
  id: number;
  url: string;
  events: string[];
  active: boolean;
  secret?: string;
  owner: string;
  repo?: string;
}

export interface WebhookDelivery {
  id: number;
  hook_id: number;
  event: string;
  action?: string;
  payload: unknown;
  status_code: number | null;
  delivered_at: string;
  duration: number | null;
  success: boolean;
  /** Provider-side id of the receiving hook when it is not a small integer (set by `deliver`). */
  hook_ref?: string;
  /** Address the delivery was sent to (set by `deliver`). */
  url?: string;
}

/**
 * A fully built delivery for a provider whose webhook format is not GitHub's:
 * the plugin chooses the address, headers (including its own signature) and
 * the exact body bytes, and the dispatcher sends it and records the result.
 */
export interface RawWebhookDelivery {
  /** Numeric hook id for the delivery history; 0 when the provider id is not numeric-safe. */
  hookId?: number;
  hookRef?: string;
  event: string;
  action?: string;
  url: string;
  method?: string;
  headers: Record<string, string>;
  body: string;
  /** The parsed payload kept in the delivery history; defaults to the parsed body. */
  payload?: unknown;
  timeoutMs?: number;
}

const MAX_DELIVERIES = 1000;

export class WebhookDispatcher {
  private subscriptions: WebhookSubscription[] = [];
  private deliveries: WebhookDelivery[] = [];
  private subscriptionIdCounter = 1;
  private deliveryIdCounter = 1;

  register(sub: Omit<WebhookSubscription, "id"> & { id?: number }): WebhookSubscription {
    const { id: explicitId, ...rest } = sub;
    const id = explicitId !== undefined ? explicitId : this.subscriptionIdCounter++;
    if (id >= this.subscriptionIdCounter) {
      this.subscriptionIdCounter = id + 1;
    }
    const subscription: WebhookSubscription = { ...rest, id };
    this.subscriptions.push(subscription);
    return subscription;
  }

  unregister(id: number): boolean {
    const idx = this.subscriptions.findIndex((s) => s.id === id);
    if (idx === -1) return false;
    this.subscriptions.splice(idx, 1);
    return true;
  }

  getSubscription(id: number): WebhookSubscription | undefined {
    return this.subscriptions.find((s) => s.id === id);
  }

  getSubscriptions(owner?: string, repo?: string): WebhookSubscription[] {
    return this.subscriptions.filter((s) => {
      if (owner && s.owner !== owner) return false;
      if (repo !== undefined && s.repo !== repo) return false;
      return true;
    });
  }

  updateSubscription(
    id: number,
    data: Partial<Pick<WebhookSubscription, "url" | "events" | "active" | "secret">>,
  ): WebhookSubscription | undefined {
    const sub = this.subscriptions.find((s) => s.id === id);
    if (!sub) return undefined;
    Object.assign(sub, data);
    return sub;
  }

  async dispatch(
    event: string,
    action: string | undefined,
    payload: unknown,
    owner: string,
    repo?: string,
  ): Promise<void> {
    const matchingSubs = this.subscriptions.filter((s) => {
      if (!s.active) return false;
      if (s.owner !== owner) return false;
      if (repo !== undefined) {
        if (s.repo !== repo) return false;
      } else if (s.repo !== undefined) {
        return false;
      }
      return event === "ping" || s.events.includes("*") || s.events.includes(event);
    });

    for (const sub of matchingSubs) {
      const delivery: WebhookDelivery = {
        id: this.deliveryIdCounter++,
        hook_id: sub.id,
        event,
        action,
        payload,
        status_code: null,
        delivered_at: new Date().toISOString(),
        duration: null,
        success: false,
      };

      const body = JSON.stringify(payload);

      const signatureHeaders: Record<string, string> = {};
      if (sub.secret) {
        const hmac = createHmac("sha256", sub.secret).update(body).digest("hex");
        signatureHeaders["X-Hub-Signature-256"] = `sha256=${hmac}`;
      }

      try {
        const start = Date.now();
        const response = await fetch(sub.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-GitHub-Event": event,
            "X-GitHub-Delivery": String(delivery.id),
            ...signatureHeaders,
          },
          body,
          signal: AbortSignal.timeout(10000),
        });
        delivery.duration = Date.now() - start;
        delivery.status_code = response.status;
        delivery.success = response.ok;
      } catch {
        delivery.duration = 0;
        delivery.success = false;
      }

      this.deliveries.push(delivery);
      if (this.deliveries.length > MAX_DELIVERIES) {
        this.deliveries.splice(0, this.deliveries.length - MAX_DELIVERIES);
      }
    }
  }

  /**
   * Send one prebuilt delivery and record it in the same history `dispatch`
   * writes, so the ledger and `/_emulate/logs` show it. Never throws: a network
   * failure is recorded as an unsuccessful delivery with no status code.
   */
  async deliver(raw: RawWebhookDelivery): Promise<WebhookDelivery> {
    let payload = raw.payload;
    if (payload === undefined) {
      try {
        payload = JSON.parse(raw.body);
      } catch {
        payload = raw.body;
      }
    }
    const delivery: WebhookDelivery = {
      id: this.deliveryIdCounter++,
      hook_id: raw.hookId ?? 0,
      event: raw.event,
      action: raw.action,
      payload,
      status_code: null,
      delivered_at: new Date().toISOString(),
      duration: null,
      success: false,
      hook_ref: raw.hookRef,
      url: raw.url,
    };
    const start = Date.now();
    try {
      const response = await fetch(raw.url, {
        method: raw.method ?? "POST",
        headers: raw.headers,
        body: raw.body,
        signal: AbortSignal.timeout(raw.timeoutMs ?? 10000),
      });
      delivery.status_code = response.status;
      delivery.success = response.ok;
      await response.body?.cancel().catch(() => {});
    } catch {
      delivery.success = false;
    }
    delivery.duration = Date.now() - start;
    this.deliveries.push(delivery);
    if (this.deliveries.length > MAX_DELIVERIES) {
      this.deliveries.splice(0, this.deliveries.length - MAX_DELIVERIES);
    }
    return delivery;
  }

  getDeliveries(hookId?: number): WebhookDelivery[] {
    if (hookId !== undefined) {
      return this.deliveries.filter((d) => d.hook_id === hookId);
    }
    return [...this.deliveries];
  }

  clear(): void {
    this.subscriptions.length = 0;
    this.deliveries.length = 0;
    this.subscriptionIdCounter = 1;
    this.deliveryIdCounter = 1;
  }

  /**
   * The registered subscriptions and id counters, for a host that rebuilds the
   * emulator from storage. Delivery history is not included: it can be large and
   * each delivery is already recorded on the request ledger.
   */
  serialize(): WebhookDispatcherSnapshot {
    return {
      subscriptions: this.subscriptions.map((s) => ({ ...s, events: [...s.events] })),
      subscriptionIdCounter: this.subscriptionIdCounter,
      deliveryIdCounter: this.deliveryIdCounter,
    };
  }

  restore(snapshot: WebhookDispatcherSnapshot | undefined): void {
    if (!snapshot) return;
    this.subscriptions = snapshot.subscriptions.map((s) => ({ ...s, events: [...s.events] }));
    this.subscriptionIdCounter = snapshot.subscriptionIdCounter;
    this.deliveryIdCounter = snapshot.deliveryIdCounter;
  }
}

export interface WebhookDispatcherSnapshot {
  subscriptions: WebhookSubscription[];
  subscriptionIdCounter: number;
  deliveryIdCounter: number;
}

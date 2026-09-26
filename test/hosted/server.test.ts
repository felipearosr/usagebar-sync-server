import { afterAll, beforeAll, expect, it } from "vitest";
import { loadHostedConfig } from "../../src/hosted/config.js";
import { startHostedServer } from "../../src/hosted/server.js";
import type { RunningServer } from "../../src/server.js";
import { FakeStripe } from "./fake-stripe.js";

let server: RunningServer;
const stripe = new FakeStripe();

beforeAll(async () => {
  const config = loadHostedConfig({
    DB_PATH: ":memory:",
    HOST: "127.0.0.1",
    PORT: "0",
    PUBLIC_URL: "http://localhost:8787",
    STRIPE_SECRET_KEY: "sk_test_fake",
    STRIPE_WEBHOOK_SECRET: "whsec_test",
    STRIPE_PRICE_ID: "price_test",
  });
  server = await startHostedServer(config, stripe);
});

afterAll(() => server.close());

it("serves the site and the Sync Server from one listener", async () => {
  const landing = await fetch(`${server.url}/`);
  expect(landing.status).toBe(200);
  expect(await landing.text()).toContain("Hosted Machine Sync");

  const info = await fetch(`${server.url}/v1/info`);
  expect(await info.json()).toMatchObject({ protocols: [1], enrollment: "required" });

  const checkout = await fetch(`${server.url}/checkout`, {
    method: "POST",
    body: new URLSearchParams({ plan: "trial" }),
    redirect: "manual",
  });
  expect(checkout.status).toBe(303);
  expect(stripe.checkouts[0]!.successUrl).toBe("http://localhost:8787/welcome?session_id={CHECKOUT_SESSION_ID}");
});

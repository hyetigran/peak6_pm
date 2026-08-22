/**
 * Alert seam (#25, #10). Routes an alert to the configured webhook receiver
 * (#10) as JSON, or logs when none is configured. Injected fetch/log for tests.
 * Run: pnpm exec tsx --test tests/keeper-alerter.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeAlerter, type AlertEvent } from "../services/keeper/src/alerter.js";

const ev = (over: Partial<AlertEvent> = {}): AlertEvent => ({ level: "critical", source: "identity", title: "drift", detail: "x", ...over });

test("no webhook configured -> logs, never throws", async () => {
  const logs: string[] = [];
  const a = makeAlerter({ log: (m) => logs.push(m) });
  await a(ev());
  assert.equal(logs.length, 1);
  assert.match(logs[0], /critical.*identity.*drift/i);
});

test("webhook configured -> POSTs JSON to the receiver", async () => {
  const calls: any[] = [];
  const fetchImpl = async (url: string, init: any) => { calls.push({ url, init }); return { ok: true, status: 200 } as any; };
  const a = makeAlerter({ webhookUrl: "https://alerts.example/hook", fetchImpl, log: () => {} });
  await a(ev({ title: "openbook drift" }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://alerts.example/hook");
  assert.equal(calls[0].init.method, "POST");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.title, "openbook drift");
  assert.equal(body.level, "critical");
});

test("a webhook failure falls back to logging (an alert is never silently lost)", async () => {
  const logs: string[] = [];
  const fetchImpl = async () => { throw new Error("network down"); };
  const a = makeAlerter({ webhookUrl: "https://alerts.example/hook", fetchImpl, log: (m) => logs.push(m) });
  await a(ev());
  assert.ok(logs.some((l) => /network down|webhook/i.test(l)), "the failure is logged");
  assert.ok(logs.some((l) => /critical/i.test(l)), "the alert itself is still logged");
});

test("a non-2xx webhook response is treated as a failure and logged", async () => {
  const logs: string[] = [];
  const fetchImpl = async () => ({ ok: false, status: 500 } as any);
  const a = makeAlerter({ webhookUrl: "https://alerts.example/hook", fetchImpl, log: (m) => logs.push(m) });
  await a(ev());
  assert.ok(logs.some((l) => /500|webhook/i.test(l)));
});
